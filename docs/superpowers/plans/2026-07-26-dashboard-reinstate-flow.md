# Dashboard Reinstate Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace one-tap AWOL reinstatement with a two-role gate (Jamaica RSR 0025 confirms the letter with her own PIN, the owner approves with the admin PIN), exempt PAKYAW/PEM workers from AWOL entirely, and give the owner manual (re-)suspension from the dashboard.

**Architecture:** The gate lives in the database. `employee_suspensions` gains a `letter_received` flag, and `awol_admin_decide` refuses to approve unless that flag is true — so no stale screen, replayed request, or forgotten button can bypass it. The kiosk needs no new push mechanism: its existing poller off `employee_suspensions where active=true` already lifts the block at both yards within seconds of an approval. Three UI surfaces change (kiosk loses its reinstate control, the coordinator page gains step 1, the dashboard gains step 2 + manual suspension), all driven by six security-definer RPCs.

**Tech Stack:** Vanilla JS + Preact/htm via CDN (no build step, no npm, no bundler). Supabase PostgREST (project `wpmcbjrisuyjvobvzaus`, RLS disabled). Playwright for the kiosk stress harness. Plain `.sql` files the owner runs by hand in the Supabase SQL editor.

**Spec:** `docs/superpowers/specs/2026-07-26-dashboard-reinstate-flow-design.md` (approved 2026-07-26).

## Global Constraints

- **This repo is LIVE PRODUCTION — the payroll pays real salaries. Be conservative.**
- No build step, no npm, no bundler, no frameworks. Vanilla JS + Preact/htm via CDN only.
- Supabase project is `wpmcbjrisuyjvobvzaus`. **Never** use or reference the abandoned project ref recorded in CLAUDE.md (referred to below as `$OLD_REF`; it is deliberately not written out anywhere in this plan, so a repo-wide grep for it stays clean).
- Hygiene check on every deliverable: `grep` for `wpmcbjrisuyjvobvzaus` (must exist where a Supabase URL appears) and `$OLD_REF` (must NOT exist anywhere). Set `$OLD_REF` once per shell, reading the value out of CLAUDE.md rather than typing it — that is what keeps this plan itself grep-clean:

```bash
OLD_REF="$(sed -n 's/.*NEVER use or reference Supabase project `\([a-z]\{20\}\)`.*/\1/p' CLAUDE.md | head -1)"
test ${#OLD_REF} -eq 20 || echo "OLD_REF did not extract — check CLAUDE.md wording before trusting any hygiene result"
```
- Validate before shipping: extract the largest inline `<script>` from any modified HTML and run `node --check` on it as an ES module. Run `node --check` directly on modified `.js` files.
- SQL uses `--` comments, never `//`. HTML/htm template literals use a literal `&`, never `&amp;`.
- Read the CURRENT live file before editing it. Never start from a stale copy.
- `attendance_records.date` is TEXT in MIXED formats (`MM/DD/YYYY` and `YYYY-MM-DD`) — fetch broadly and filter client-side with `toISO()`/`awolISO()`. Never use Supabase gte/lte range filters on it.
- **Payroll is untouched by this build.** No pay math changes, no `attendance_records` schema change.
- **Nothing is pushed to `main` without the owner's localhost walkthrough and an explicit "push"** (all three surfaces are interactive; kiosk is punch-blocking).
- Exact copy, verbatim from the spec — Bisaya kiosk modal:
  > **GI-SUSPEND ANG IMONG ACCOUNT**
  > Absent ka og 3+ ka adlaw nga sunod-sunod nga walay approved nga leave.
  > Kuhaa ug sulati ang AWOL letter, ihatag sa coordinator, dayon hulaton ang approval sa admin una ka maka-punch.
- Neutral PIN-refusal copy (owner-approved, must not name Jamaica): `This PIN is not authorised for the AWOL letter step`.
- A manual suspension **requires at least one absent date** (owner-approved) — enforced in the RPC and in the form.
- PEM/PAKYAW test is on the employee code, case-insensitive and whitespace-stripped: `PEM 0001` and `PEM9001` both match.

---

## File Structure

**Create:**
- `awol-reinstate-flow.sql` — the single SQL pass the owner runs: census → backup → delete the 43 walkthrough rows → new columns → `awol_events` → six RPCs → seed `is_awol_clerk` → re-query.
- `tests/awol-reinstate-flow/verify-sql.mjs` — read-mostly REST verification of the SQL, run after the owner executes it. Uses throwaway `TEST999` / `PEM TEST9` codes and deletes them.
- `tests/kiosk-stress/awol-realdata-check.mjs` — the owner's gate item: runs the REAL kiosk `collectAbsentDates`/`checkAllAbsences` against REAL 2026-07-19 → 2026-07-25 attendance, with every write mocked, and asserts zero suspensions.
- `tests/awol-dashboard/dashboard-awol.smoke.mjs` — Playwright smoke over `home.js` + `coordinator.js` with mocked Supabase; asserts list routing, the absent Approve button, and PIN gating.

**Modify:**
- `kiosk/index.html` — PEM skip in `checkAllAbsences` (~2254); reinstate button removed from `renderRoster` (~4794); Telegram `reqType === 'reinstate'` branch removed (~4326); `reinstateEmployee`/`sendAwolReinstatedMsg` relabelled to CANCELLED (~2312–2331); Bisaya modal text (~2047); version stamp (line 238).
- `home.js` — AWOL card + approve/keep + admin fallback tick + manual (re-)suspension + Telegram sender; anchored after `${healthBanner()}` (line 1575).
- `coordinator.js` — new `awol` area: letters card + Jamaica PIN tick; area menu (~1565) and area router (~1600).
- `tests/kiosk-stress/kiosk-stress.mjs` — mock the four new RPCs and the new columns; re-point G8c off PEM9001; new PEM/gate/keep/manual scenarios.
- `preflight.html` — EXPECT stamps (line 38–44).

**Responsibility split:** the SQL file owns the gate and the audit trail; the kiosk owns detection and blocking; `coordinator.js` owns step 1; `home.js` owns step 2 and manual suspension. Each UI file talks to the DB only through the RPCs — no direct table writes to `employee_suspensions` outside them (the existing msg-id PATCH in the kiosk is the one grandfathered exception).

---

## Task 1: SQL — cleanup, gate schema, RPCs

**Files:**
- Create: `awol-reinstate-flow.sql`
- Create: `tests/awol-reinstate-flow/verify-sql.mjs`

**Interfaces:**
- Consumes: existing `public.employee_suspensions`, `public.employees`, `public.settings`.
- Produces (every later task depends on these exact signatures):
  - `awol_is_pem(p_code text) → boolean`
  - `awol_clerk_for_pin(p_pin text) → jsonb` — `{ok:true, code, name}` or `{ok:false}`
  - `awol_letter_received(p_code text, p_by text) → jsonb` — `{newly:bool}`
  - `awol_admin_decide(p_code text, p_by text, p_decision text) → jsonb` — `p_decision` is `'approve'` or `'keep'`; returns `{newly:true, awol_group_msg_id, awol_group_chat}` on approve, `{newly:true, kept:true}` on keep, `{newly:false, reason}` otherwise
  - `awol_manual_suspend(p_code text, p_by text, p_reason text, p_dates jsonb, p_ref_note text, p_letter_on_file boolean) → jsonb` — `{newly:bool, reason?}`
  - `awol_set_suspended(p_code, p_reason, p_dates, p_on) → boolean` (existing signature, now PEM-guarded)
  - `awol_reinstate(p_code, p_by, p_on) → jsonb` (existing signature, now the leave-cancel path only)
  - New columns on `employee_suspensions`: `letter_received`, `letter_received_by`, `letter_received_at`, `last_decision`, `last_decision_by`, `last_decision_at`, `manual`, `ref_note`
  - New column `employees.is_awol_clerk boolean`
  - New table `awol_events(id, employee_code, event, actor, note, at)`

- [ ] **Step 1: Write the verification script (it must fail first)**

Create `tests/awol-reinstate-flow/verify-sql.mjs`:

```js
// Verifies awol-reinstate-flow.sql AFTER the owner has run it in the Supabase SQL editor.
// Read-mostly: the only writes are throwaway probe codes (TEST999 / "PEM TEST9"), deleted at the end.
// Run: node tests/awol-reinstate-flow/verify-sql.mjs
const URL_BASE = 'https://wpmcbjrisuyjvobvzaus.supabase.co';
const KEY = process.env.RSR_ANON_KEY;
if (!KEY) { console.error('Set RSR_ANON_KEY (the anon key from supabase.js) and re-run.'); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${name}${detail ? `\n        ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
const rpc = async (fn, body) => {
  const r = await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const rest = async (path, init) => {
  const r = await fetch(`${URL_BASE}/rest/v1/${path}`, { headers: H, ...init });
  return { status: r.status, data: await r.json().catch(() => null) };
};

// ── 0. migration probe — is awol-reinstate-flow.sql applied yet? ──
// awol_is_pem() is created in STEP 5 of the migration and did not exist before it. Two of the RPCs
// this script otherwise calls (awol_set_suspended, awol_reinstate) already existed in production
// from an earlier build — running the mutating sections below against a pre-migration database
// once wrote two real probe rows (TEST999, PEM TEST9) straight into live data. Detect that state up
// front and keep this run to schema/read-only checks until the migration is confirmed present.
const probe = await rpc('awol_is_pem', { p_code: 'PROBE' });
const migrationApplied = typeof probe.data === 'boolean';
if (!migrationApplied) {
  console.log('\x1b[33mNOTICE\x1b[0m: migration not yet applied — awol_is_pem() was not found.');
  console.log('Running schema/read-only checks only (rows, columns, clerk seed). No RPC that writes will be called.\n');
}

// ── 1. cleanup landed ──
const all = await rest('employee_suspensions?select=employee_code,active');
check('walkthrough rows deleted (0 rows remain)', Array.isArray(all.data) && all.data.length === 0,
  `rows=${Array.isArray(all.data) ? all.data.length : JSON.stringify(all.data)}`);
const bak = await rest('bak_employee_suspensions_20260726?select=employee_code');
check('backup table holds the 45 deleted rows', Array.isArray(bak.data) && bak.data.length === 45,
  `backup rows=${Array.isArray(bak.data) ? bak.data.length : JSON.stringify(bak.data)}`);

// ── 2. new columns exist ──
const cols = await rest('employee_suspensions?select=employee_code,letter_received,letter_received_by,letter_received_at,last_decision,last_decision_by,last_decision_at,manual,ref_note&limit=1');
check('all 8 gate columns selectable', cols.status === 200, `status=${cols.status} ${JSON.stringify(cols.data)}`);

// ── 3. Jamaica is the only AWOL clerk ──
const clerks = await rest('employees?select=code,name,is_awol_clerk&is_awol_clerk=eq.true');
check('exactly one AWOL clerk, and it is RSR 0025',
  Array.isArray(clerks.data) && clerks.data.length === 1 &&
  clerks.data[0].code.replace(/\s/g, '').toUpperCase() === 'RSR0025',
  JSON.stringify(clerks.data));

if (!migrationApplied) {
  console.log(`\n${pass} passed, ${fail} failed\n`);
  console.log('Mutating sections (PEM guard writes, the two-step gate, manual suspension, clerk PIN, audit log)');
  console.log('were SKIPPED and wrote nothing. Re-run this script after the owner applies awol-reinstate-flow.sql.');
  process.exit(fail ? 1 : 0);
}

// From here on the migration is confirmed present, so it is safe to exercise the mutating RPCs.
// Still wrapped in try/catch: an unexpected error here (a table that vanished mid-run, a network
// blip) must be reported as a failed check, not a stack trace that skips the summary line below.
try {
// ── 4. PEM guard ──
check('awol_is_pem("PEM 0001") is true',  (await rpc('awol_is_pem', { p_code: 'PEM 0001' })).data === true);
check('awol_is_pem("PEM9001") is true',   (await rpc('awol_is_pem', { p_code: 'PEM9001' })).data === true);
check('awol_is_pem("RSR 0006") is false', (await rpc('awol_is_pem', { p_code: 'RSR 0006' })).data === false);
const pemSet = await rpc('awol_set_suspended', { p_code: 'PEM TEST9', p_reason: 'probe', p_dates: ['2026-07-20'], p_on: '07/26/2026' });
check('awol_set_suspended refuses a PEM code', pemSet.data === false, JSON.stringify(pemSet.data));
const pemMan = await rpc('awol_manual_suspend', { p_code: 'PEM TEST9', p_by: 'probe', p_reason: 'probe', p_dates: ['2026-07-20'], p_ref_note: null, p_letter_on_file: false });
check('awol_manual_suspend refuses a PEM code', pemMan.data && pemMan.data.newly === false, JSON.stringify(pemMan.data));

// ── 5. the two-step gate, end to end, on a throwaway code ──
const s1 = await rpc('awol_set_suspended', { p_code: 'TEST999', p_reason: 'probe', p_dates: ['2026-07-20'], p_on: '07/26/2026' });
check('probe suspension created (newly=true)', s1.data === true, JSON.stringify(s1.data));
const early = await rpc('awol_admin_decide', { p_code: 'TEST999', p_by: 'probe', p_decision: 'approve' });
check('approve REFUSED before the letter is confirmed',
  early.data && early.data.newly === false && /letter/i.test(early.data.reason || ''), JSON.stringify(early.data));
const tick = await rpc('awol_letter_received', { p_code: 'TEST999', p_by: 'probe-clerk' });
check('letter tick accepted (newly=true)', tick.data && tick.data.newly === true, JSON.stringify(tick.data));
const tick2 = await rpc('awol_letter_received', { p_code: 'TEST999', p_by: 'probe-clerk' });
check('second letter tick is idempotent (newly=false)', tick2.data && tick2.data.newly === false, JSON.stringify(tick2.data));
const keep = await rpc('awol_admin_decide', { p_code: 'TEST999', p_by: 'probe-admin', p_decision: 'keep' });
check('keep-suspended accepted', keep.data && keep.data.newly === true && keep.data.kept === true, JSON.stringify(keep.data));
const afterKeep = await rest('employee_suspensions?select=active,letter_received&employee_code=eq.TEST999');
check('keep leaves the row ACTIVE and clears the tick',
  afterKeep.data && afterKeep.data[0] && afterKeep.data[0].active === true && afterKeep.data[0].letter_received === false,
  JSON.stringify(afterKeep.data));
const early2 = await rpc('awol_admin_decide', { p_code: 'TEST999', p_by: 'probe', p_decision: 'approve' });
check('approve refused again after keep reset the tick', early2.data && early2.data.newly === false, JSON.stringify(early2.data));
await rpc('awol_letter_received', { p_code: 'TEST999', p_by: 'probe-clerk' });
const appr = await rpc('awol_admin_decide', { p_code: 'TEST999', p_by: 'probe-admin', p_decision: 'approve' });
check('approve accepted once the letter is confirmed', appr.data && appr.data.newly === true, JSON.stringify(appr.data));
const afterAppr = await rest('employee_suspensions?select=active,last_decision&employee_code=eq.TEST999');
check('approve sets active=false, last_decision=approved',
  afterAppr.data && afterAppr.data[0] && afterAppr.data[0].active === false && afterAppr.data[0].last_decision === 'approved',
  JSON.stringify(afterAppr.data));

// ── 6. manual suspension + date requirement ──
const noDates = await rpc('awol_manual_suspend', { p_code: 'TEST999', p_by: 'probe', p_reason: 'probe', p_dates: [], p_ref_note: null, p_letter_on_file: false });
check('manual suspension refused with no absent dates',
  noDates.data && noDates.data.newly === false && /date/i.test(noDates.data.reason || ''), JSON.stringify(noDates.data));
const re = await rpc('awol_manual_suspend', { p_code: 'TEST999', p_by: 'probe-admin', p_reason: 'probe re-suspension', p_dates: ['2026-07-20'], p_ref_note: 'manual re-suspension, ref: case of 07/26/2026 — letter already on file', p_letter_on_file: true });
check('manual re-suspension accepted', re.data && re.data.newly === true, JSON.stringify(re.data));
const afterRe = await rest('employee_suspensions?select=active,letter_received,manual,ref_note&employee_code=eq.TEST999');
check('re-suspension lands straight at "needs decision" (letter_received=true, manual=true)',
  afterRe.data && afterRe.data[0] && afterRe.data[0].active === true &&
  afterRe.data[0].letter_received === true && afterRe.data[0].manual === true && !!afterRe.data[0].ref_note,
  JSON.stringify(afterRe.data));

// ── 7. clerk PIN check ──
const badPin = await rpc('awol_clerk_for_pin', { p_pin: '000000' });
check('awol_clerk_for_pin rejects an unknown PIN and leaks nothing',
  badPin.data && badPin.data.ok === false && !badPin.data.code && !badPin.data.name, JSON.stringify(badPin.data));

// ── 8. audit log ──
const ev = await rest('awol_events?select=event,actor&employee_code=eq.TEST999&order=at.asc');
const names = Array.isArray(ev.data) ? ev.data.map(e => e.event) : [];
check('awol_events recorded the whole probe lifecycle',
  Array.isArray(ev.data) && ['suspended', 'letter_received', 'kept_suspended', 'reinstated', 'suspended_manual'].every(e => names.includes(e)),
  `events=${names.join(', ')}${Array.isArray(ev.data) ? '' : ` (unexpected response: ${JSON.stringify(ev.data)})`}`);

// ── probe rows: report them, do NOT try to delete ──
// anon holds select/insert/update on employee_suspensions and select/insert on awol_events — by
// design, so a client can never erase an audit trail. The probe rows are removed by the OWNER via
// STEP 14 of the SQL file. This script only reports what is left for them to clear.
const leftover = await rest('employee_suspensions?select=employee_code&or=(employee_code.eq.TEST999,employee_code.eq.PEM%20TEST9)');
console.log(`\nPROBE ROWS TO CLEAR (owner runs STEP 14): ${(Array.isArray(leftover.data) ? leftover.data : []).map(r => r.employee_code).join(', ') || '(none)'}`);
} catch (err) {
  check('mutating RPC checks completed without throwing', false, `threw: ${err && err.stack || err}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
```

**Why the script does not clean up after itself:** `anon` deliberately has no `delete` on either table — that is what makes the audit trail trustworthy, and the prior build already confirmed `employee_suspensions` grants only select/insert/update. A `DELETE` from the client would fail silently and leave the probe rows behind while the check reported success. The owner clears them with STEP 14, and the run above tells them exactly what to clear.

- [ ] **Step 2: Run it to confirm it fails**

```bash
RSR_ANON_KEY="$(grep -o "eyJ[A-Za-z0-9._-]*" supabase.js | head -1)" node tests/awol-reinstate-flow/verify-sql.mjs
```

Expected: FAIL on nearly every check — `bak_employee_suspensions_20260726` does not exist, the gate columns 404, `awol_is_pem` is not found, and 45 rows still remain.

**Note:** because the migration is not yet applied, `awol_is_pem` is not found, so the guard at the top of the script now detects this and runs schema checks ONLY (rows, columns, clerk seed) — it exits before reaching any RPC that writes (`awol_set_suspended`, `awol_admin_decide`, `awol_letter_received`, `awol_manual_suspend`). A pre-migration run therefore writes nothing; the earlier version of this script did not have that guard, which is how a pre-migration run once wrote two real probe rows (TEST999, PEM TEST9) into production.

- [ ] **Step 3: Write `awol-reinstate-flow.sql`**

```sql
-- ═══════════════════════════════════════════════════════════════════════════════
--  AWOL reinstate flow — walkthrough cleanup + two-role gate + PEM exemption
--  Spec: docs/superpowers/specs/2026-07-26-dashboard-reinstate-flow-design.md
--  Additive + idempotent EXCEPT step 2 (a one-time DELETE, backed up in step 1) — STEP 2 ships
--  commented out; see its own "RUN ONCE" banner before ever uncommenting it.
--
--  HOW TO RUN THIS FILE — TWO SEPARATE PASTES, NOT ONE:
--    PASTE 1 — STEP 0 ONLY. Select and run just the STEP 0 census below, by itself, and read the
--              three numbers it returns against the EXPECT line before doing anything else. The
--              Supabase SQL editor only shows the result of the LAST statement in a paste, so if
--              STEP 0 is pasted together with anything below it, its numbers are never seen and
--              this stop-and-eyeball gate cannot fire.
--    PASTE 2 — everything from STEP 1 to the end of the file, run once STEP 0's numbers check out.
--              STEP 2 and STEP 14 stay commented out inside this second paste — see their own
--              banners before ever uncommenting either one.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── STEP 0 — CENSUS  ▓▓▓ PASTE 1 — RUN THIS STATEMENT ALONE, NOTHING ELSE ▓▓▓ ──
select count(*) as total,
       count(*) filter (where active)     as active_now,
       count(*) filter (where not active) as inactive
  from public.employee_suspensions;
-- EXPECT (owner-confirmed 2026-07-26): total = 45, active_now = 0, inactive = 45.
-- Of the 45: 43 are the original walkthrough rows, and 2 (TEST999, PEM TEST9) are inactive probe
-- rows written by the pre-migration verification run (it called two RPCs that already existed in
-- production from an earlier build). Both are already inactive, so all 45 are removed by STEP 2
-- below, which deletes inactive rows only.
-- If active_now > 0 someone is REALLY suspended right now — STOP and re-check before step 2.

-- ═══════════════════════════════════════════════════════════════════════════════
-- ▓▓▓  STOP.  Confirm the STEP 0 numbers above match EXPECT before going any further.  ▓▓▓
-- ▓▓▓  PASTE 2 starts on the next line: select from STEP 1 to the end and run it separately.  ▓▓▓
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── STEP 1 — BACKUP everything before deleting ───────────────────────────────
create table if not exists public.bak_employee_suspensions_20260726 as
  select * from public.employee_suspensions;
-- Mirrors STEP 8's treatment of the throttle table: a backup a client can erase with the anon key
-- is not a backup. Supabase's default privileges can otherwise expose a freshly created table to
-- anon, which would include DELETE on the only copy of the rows STEP 2 is about to destroy.
revoke all on public.bak_employee_suspensions_20260726 from anon, authenticated;
select count(*) as backed_up from public.bak_employee_suspensions_20260726;   -- expect 45

-- ═══════════════════════════════════════════════════════════════════════════════
-- ── STEP 2 — RUN ONCE — uncomment deliberately — delete the walkthrough residue ──
-- STEP 1's `create table if not exists` is a no-op on every run after the first, so its backup is
-- only written FRESH the very first time this file executes. If this file is ever re-pasted later,
-- re-running this DELETE would remove every resolved suspension since then with NO fresh backup
-- underneath it. The `active is not true` guard means it can never touch a LIVE suspension, but
-- that does not make a second run of this delete safe. Uncomment the two lines below only the
-- first time this file is run, then leave them commented out for good.
-- ═══════════════════════════════════════════════════════════════════════════════
-- delete from public.employee_suspensions where active is not true;
-- select count(*) as remaining from public.employee_suspensions;                -- expect 0

-- ── STEP 3 — PAKYAW/PEM exemption helper ─────────────────────────────────────
-- Moved ahead of the gate columns (was STEP 5) so the PEM guard constraint added in STEP 4 below
-- has something to reference — a check constraint cannot call a function that does not exist yet.
-- Owner rule 2026-07-26: PAKYAW/PEM workers are exempt from AWOL entirely — piece-rate/casual,
-- irregular attendance is normal. The employee CODE PREFIX is the marker (coordinator.js sets it
-- at creation: empType 'RSR' = regular, 'PEM' = pakyaw). Normalized like the client normCode —
-- upper-cased with whitespace stripped — so 'PEM 0001' and 'PEM9001' both match.
create or replace function public.awol_is_pem(p_code text)
returns boolean language sql immutable as $$
  select upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g')) like 'PEM%';
$$;
grant execute on function public.awol_is_pem(text) to anon, authenticated;

-- ── STEP 4 — two-role gate columns + PEM exemption constraint ────────────────
alter table public.employee_suspensions
  add column if not exists letter_received    boolean not null default false,
  add column if not exists letter_received_by text,
  add column if not exists letter_received_at timestamptz,
  add column if not exists last_decision      text,
  add column if not exists last_decision_by   text,
  add column if not exists last_decision_at   timestamptz,
  add column if not exists manual             boolean not null default false,
  add column if not exists ref_note           text;

-- Belt-and-braces at the schema level: the PEM guard inside awol_set_suspended/awol_manual_suspend
-- refuses a PEM code, but employee_suspensions still grants insert to anon, so a raw REST insert
-- could otherwise create a suspension for a pakyaw worker straight past the RPCs. This closes that
-- path. STEP 2 empties the table first, so the constraint has nothing pre-existing to violate.
-- Guarded via pg_constraint so re-running this file is a no-op instead of an error.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'employee_suspensions_no_pem') then
    alter table public.employee_suspensions
      add constraint employee_suspensions_no_pem check (not public.awol_is_pem(employee_code));
  end if;
end $$;

-- ── STEP 5 — append-only audit log ───────────────────────────────────────────
-- The suspension row is REUSED on every cycle, so without this a repeat offender's
-- history is overwritten. This is the permanent trail behind "Recently closed".
create table if not exists public.awol_events (
  id            bigserial   primary key,
  employee_code text        not null,
  event         text        not null,   -- suspended | suspended_manual | letter_received
                                        -- | reinstated | kept_suspended | cancelled_leave_approved
  actor         text,
  note          text,
  at            timestamptz not null default now()
);
create index if not exists awol_events_code_at_idx on public.awol_events (employee_code, at desc);
-- SELECT only: every event insert happens inside a security definer RPC, which runs as the
-- function owner and needs no table grant to write. Granting anon INSERT (plus sequence usage)
-- would let anyone holding the public anon key forge audit entries directly — e.g. a fake
-- letter_received event attributed to a named person. No delete grant either: an append-only log
-- a client can delete is not append-only. Probe rows from the verification script are removed by
-- the owner in STEP 14 below, not by the client.
grant select on public.awol_events to anon, authenticated;

-- ── STEP 6 — detection RPC: PEM guard + reset the gate on a NEW suspension ───
-- Replaces the 07-24 version. Two changes: a PEM refusal, and clearing the gate/decision
-- columns when a row is re-activated (a new case must start at "waiting for the letter").
create or replace function public.awol_set_suspended(p_code text, p_reason text, p_dates jsonb, p_on text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_newly boolean;
begin
  if awol_is_pem(p_code) then return false; end if;   -- PAKYAW exempt: no suspension, no alert
  insert into employee_suspensions(employee_code, active, reason, suspended_on, absent_dates, updated_at)
    values (p_code, true, p_reason, p_on, p_dates, now())
    on conflict (employee_code) do update
      set active = true, reason = excluded.reason, suspended_on = excluded.suspended_on,
          absent_dates = excluded.absent_dates,
          awol_group_msg_id = null, awol_group_chat = null,
          reinstated_by = null, reinstated_on = null,
          letter_received = false, letter_received_by = null, letter_received_at = null,
          last_decision = null, last_decision_by = null, last_decision_at = null,
          manual = false, ref_note = null,
          updated_at = now()
      where employee_suspensions.active is distinct from true
  returning true into v_newly;
  if coalesce(v_newly, false) then
    insert into awol_events(employee_code, event, actor, note)
      values (p_code, 'suspended', 'detection', p_reason);
  end if;
  return coalesce(v_newly, false);
end $$;
grant execute on function public.awol_set_suspended(text, text, jsonb, text) to anon, authenticated;

-- ── STEP 7 — leave-approval auto-cancel (the ONLY caller of this now) ────────
-- Owner decision: an absence later covered by an APPROVED leave means the suspension was issued
-- in error. It clears with no letter and no two-step, and is logged as CANCELLED — never as a
-- reinstatement, so the two are always distinguishable.
-- Renamed from awol_reinstate (2026-07-26 review): the old name un-suspended unconditionally and
-- stamped the permanent audit log with "absence covered by an approved leave" regardless of why it
-- was actually called — so any legacy or raw caller bypassed the two-role gate AND wrote a false
-- statement into awol_events. A caller that still expects awol_reinstate now fails loudly (function
-- not found) instead of silently mislabelling the record.
create or replace function public.awol_cancel_leave_approved(p_code text, p_by text, p_on text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_msg text; v_chat text;
begin
  update employee_suspensions
     set active = false, reinstated_by = p_by, reinstated_on = p_on,
         last_decision = 'cancelled_leave_approved', last_decision_by = p_by,
         last_decision_at = now(), updated_at = now()
   where employee_code = p_code and active is true
  returning awol_group_msg_id, awol_group_chat into v_msg, v_chat;
  if not found then
    return jsonb_build_object('newly', false);
  end if;
  insert into awol_events(employee_code, event, actor, note)
    values (p_code, 'cancelled_leave_approved', p_by, 'absence covered by an approved leave');
  return jsonb_build_object('newly', true, 'awol_group_msg_id', v_msg, 'awol_group_chat', v_chat);
end $$;
grant execute on function public.awol_cancel_leave_approved(text, text, text) to anon, authenticated;

-- Drop the old ungated entry point now that the renamed function above exists. The only legitimate
-- caller of the old name was the kiosk's leave-approval path (now switched to
-- awol_cancel_leave_approved), so this was renamed specifically so a stale cached build or a raw
-- REST rpc call can no longer reach the old ungated entry point.
drop function if exists public.awol_reinstate(text, text, text);

-- ── STEP 8 — the AWOL clerk (Jamaica only) + its throttle ────────────────────
alter table public.employees add column if not exists is_awol_clerk boolean not null default false;

-- Same GLOBAL fail-closed throttle shape as admin_verify_passcode: one shared credential space,
-- no trustworthy per-caller identity (x-forwarded-for is client-rotatable, inet_client_addr() is
-- the Supabase pooler). REST-locked so anon can neither read nor reset the counters.
create table if not exists public.awol_clerk_throttle (
  id           boolean     primary key default true check (id),
  fails        integer     not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
insert into public.awol_clerk_throttle (id) values (true) on conflict (id) do nothing;
revoke all on public.awol_clerk_throttle from anon, authenticated;

-- Identify the AWOL clerk from a typed PIN. Returns {ok:true, code, name} or {ok:false} — never the
-- PIN, and a throttled state is indistinguishable from a wrong PIN (no oracle leak). Deliberately
-- keyed on is_awol_clerk and NOT is_issuer: RSR 0005 and RSR 0023 are issuers and must be refused.
create or replace function public.awol_clerk_for_pin(p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_now  timestamptz := now();
  v_row  public.awol_clerk_throttle%rowtype;
  v_code text;
  v_name text;
  MAX_FAILS constant int      := 10;
  COOLDOWN  constant interval := interval '15 minutes';
begin
  insert into public.awol_clerk_throttle (id) values (true) on conflict (id) do nothing;
  select * into v_row from public.awol_clerk_throttle where id for update;

  -- FAIL-CLOSED: while globally locked, deny WITHOUT checking the PIN.
  if v_row.locked_until is not null and v_row.locked_until > v_now then
    update public.awol_clerk_throttle set updated_at = v_now where id;
    return jsonb_build_object('ok', false);
  end if;

  if v_now - v_row.window_start > COOLDOWN then
    v_row.fails := 0;
    v_row.window_start := v_now;
  end if;

  select e.code, e.name into v_code, v_name
    from public.employees e
   where e.is_awol_clerk = true and e.pin is not null and e.pin = p_pin
   limit 1;

  if v_code is null then
    update public.awol_clerk_throttle
       set fails        = v_row.fails + 1,
           window_start = v_row.window_start,
           locked_until = case when v_row.fails + 1 >= MAX_FAILS then v_now + COOLDOWN else null end,
           updated_at   = v_now
     where id;
    return jsonb_build_object('ok', false);
  end if;

  update public.awol_clerk_throttle
     set fails = 0, window_start = v_now, locked_until = null, updated_at = v_now
   where id;
  return jsonb_build_object('ok', true, 'code', v_code, 'name', v_name);
end $$;
grant execute on function public.awol_clerk_for_pin(text) to anon, authenticated;

-- ── STEP 9 — STEP 1 of the gate: letter received ─────────────────────────────
-- Idempotent: a double-tap returns {newly:false} so exactly one Telegram message is posted.
create or replace function public.awol_letter_received(p_code text, p_by text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  update employee_suspensions
     set letter_received = true, letter_received_by = p_by, letter_received_at = now(), updated_at = now()
   where employee_code = p_code and active is true and letter_received is not true;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('newly', false);
  end if;
  insert into awol_events(employee_code, event, actor, note)
    values (p_code, 'letter_received', p_by, null);
  return jsonb_build_object('newly', true);
end $$;
grant execute on function public.awol_letter_received(text, text) to anon, authenticated;

-- ── STEP 10 — STEP 2 of the gate: the admin decision ─────────────────────────
-- THIS IS WHERE THE TWO-STEP GATE ACTUALLY LIVES. 'approve' refuses unless the letter is
-- confirmed, so a stale screen, a replayed request, or a future UI bug cannot bypass it.
create or replace function public.awol_admin_decide(p_code text, p_by text, p_decision text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row employee_suspensions%rowtype; v_msg text; v_chat text;
begin
  if p_decision not in ('approve', 'keep') then
    return jsonb_build_object('newly', false, 'reason', 'unknown decision');
  end if;

  select * into v_row from employee_suspensions where employee_code = p_code for update;
  if not found or v_row.active is not true then
    return jsonb_build_object('newly', false, 'reason', 'not currently suspended');
  end if;

  if p_decision = 'approve' then
    if v_row.letter_received is not true then
      return jsonb_build_object('newly', false, 'reason', 'letter not yet confirmed');
    end if;
    update employee_suspensions
       set active = false, reinstated_by = p_by,
           reinstated_on = to_char(now() at time zone 'Asia/Manila', 'MM/DD/YYYY'),
           last_decision = 'approved', last_decision_by = p_by, last_decision_at = now(),
           updated_at = now()
     where employee_code = p_code
    returning awol_group_msg_id, awol_group_chat into v_msg, v_chat;
    insert into awol_events(employee_code, event, actor, note) values (p_code, 'reinstated', p_by, null);
    return jsonb_build_object('newly', true, 'awol_group_msg_id', v_msg, 'awol_group_chat', v_chat);
  end if;

  -- keep: stays blocked, and the letter tick is CLEARED so the case returns to the clerk's list.
  update employee_suspensions
     set letter_received = false, letter_received_by = null, letter_received_at = null,
         last_decision = 'kept', last_decision_by = p_by, last_decision_at = now(), updated_at = now()
   where employee_code = p_code;
  insert into awol_events(employee_code, event, actor, note) values (p_code, 'kept_suspended', p_by, null);
  return jsonb_build_object('newly', true, 'kept', true);
end $$;
grant execute on function public.awol_admin_decide(text, text, text) to anon, authenticated;

-- ── STEP 11 — manual suspension / re-suspension from the dashboard ───────────
-- p_letter_on_file = true is the wrong-approval recovery: the letter is already on file, so the
-- case lands straight in "needs your decision" — no new letter, no second tick.
create or replace function public.awol_manual_suspend(p_code text, p_by text, p_reason text,
                                                      p_dates jsonb, p_ref_note text,
                                                      p_letter_on_file boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_newly boolean; v_letter boolean := coalesce(p_letter_on_file, false);
begin
  if awol_is_pem(p_code) then
    return jsonb_build_object('newly', false, 'reason', 'PAKYAW/PEM workers are exempt from AWOL');
  end if;
  -- Owner rule: at least one absent date. The printable letter is built from these, so an empty
  -- list would hand the worker a letter with a blank absence section to sign.
  if p_dates is null or jsonb_typeof(p_dates) <> 'array' or jsonb_array_length(p_dates) = 0 then
    return jsonb_build_object('newly', false, 'reason', 'at least one absent date is required');
  end if;

  insert into employee_suspensions(employee_code, active, reason, suspended_on, absent_dates,
                                   letter_received, letter_received_by, letter_received_at,
                                   manual, ref_note, updated_at)
    values (p_code, true, p_reason,
            to_char(now() at time zone 'Asia/Manila', 'MM/DD/YYYY'), p_dates,
            v_letter,
            case when v_letter then p_by  else null end,
            case when v_letter then now() else null end,
            true, p_ref_note, now())
    on conflict (employee_code) do update
      set active = true, reason = excluded.reason, suspended_on = excluded.suspended_on,
          absent_dates = excluded.absent_dates,
          awol_group_msg_id = null, awol_group_chat = null,
          reinstated_by = null, reinstated_on = null,
          letter_received = excluded.letter_received,
          letter_received_by = excluded.letter_received_by,
          letter_received_at = excluded.letter_received_at,
          last_decision = null, last_decision_by = null, last_decision_at = null,
          manual = true, ref_note = excluded.ref_note, updated_at = now()
      where employee_suspensions.active is distinct from true
  returning true into v_newly;

  if not coalesce(v_newly, false) then
    return jsonb_build_object('newly', false, 'reason', 'already suspended');
  end if;
  insert into awol_events(employee_code, event, actor, note)
    values (p_code, 'suspended_manual', p_by, coalesce(p_ref_note, p_reason));
  return jsonb_build_object('newly', true);
end $$;
grant execute on function public.awol_manual_suspend(text, text, text, jsonb, text, boolean) to anon, authenticated;

-- ── STEP 12 — seed the AWOL clerk: RSR 0025 Jamaica L. Batucan, and nobody else ──
-- Matched on the NORMALIZED code (upper-case, whitespace stripped) so 'RSR 0025' == 'RSR0025',
-- exactly like the client normCode. Seeding by CODE (not name) means a spacing or case difference
-- cannot silently miss the intended person.
update public.employees set is_awol_clerk = false where is_awol_clerk = true;
update public.employees set is_awol_clerk = true
 where upper(regexp_replace(code, '\s', '', 'g')) = 'RSR0025';

-- ── STEP 13 — RE-QUERY / verify ──────────────────────────────────────────────
select count(*) as suspensions_remaining from public.employee_suspensions;    -- expect 0
select code, name, is_awol_clerk from public.employees where is_awol_clerk;    -- expect exactly RSR 0025
select count(*) as events from public.awol_events;                            -- expect 0
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'employee_suspensions'
 order by ordinal_position;

-- ═══════════════════════════════════════════════════════════════════════════════
-- ── STEP 14 — RUN THIS SEPARATELY, *AFTER* the verification script has been run ──
-- The verification script exercises the RPCs against two throwaway codes, TEST999 and 'PEM TEST9'.
-- It cannot delete them itself: anon holds no delete on either table, deliberately, so that no
-- client can erase an audit trail. Clear the probes here once verification has passed.
-- ═══════════════════════════════════════════════════════════════════════════════
-- delete from public.employee_suspensions where employee_code in ('TEST999', 'PEM TEST9');
-- delete from public.awol_events          where employee_code in ('TEST999', 'PEM TEST9');
-- select count(*) as suspensions_remaining from public.employee_suspensions;   -- expect 0
-- select count(*) as events_remaining      from public.awol_events;            -- expect 0
```

**STEP 14 is commented out on purpose.** It must not run in the same pass as STEP 0–13, because the probe rows it clears do not exist until the verification script has run. The owner uncomments and runs it as a second, separate paste once verification is green.

- [ ] **Step 4: Hygiene + ask the owner to run it, then verify**

```bash
grep -c "$OLD_REF" awol-reinstate-flow.sql   # must print 0
```

Hand the file to the owner (complete file, never a diff). After they run it:

```bash
RSR_ANON_KEY="$(grep -o "eyJ[A-Za-z0-9._-]*" supabase.js | head -1)" node tests/awol-reinstate-flow/verify-sql.mjs
```

Expected: `21 passed, 0 failed`. **Do not proceed to Task 2 until this is green** — every later task calls these RPCs.

- [ ] **Step 5: Commit**

```bash
git add awol-reinstate-flow.sql tests/awol-reinstate-flow/verify-sql.mjs
git commit -m "feat(awol): SQL — walkthrough cleanup, two-role gate schema, PEM exemption, six RPCs"
```

---

## Task 2: Kiosk — PAKYAW/PEM exemption

**Files:**
- Modify: `kiosk/index.html:2254` (`checkAllAbsences`)
- Modify: `tests/kiosk-stress/kiosk-stress.mjs` — G8c re-point (~1110) + new scenario

**Interfaces:**
- Consumes: `awol_is_pem` semantics from Task 1 (client-side mirror, same normalization).
- Produces: `isPemCode(code) → boolean` in kiosk scope, used by Task 3's roster rendering.

- [ ] **Step 1: Write the failing harness scenario**

Add to `tests/kiosk-stress/kiosk-stress.mjs`, immediately after the existing G8 scenario block:

```js
// G9 — PAKYAW/PEM EXEMPTION (owner 2026-07-26): piece-rate/casual workers have irregular
// attendance by nature. They are skipped COMPLETELY — no suspension, no alert, no letter, and
// no pending-leave HOLD note. The employee CODE PREFIX is the marker (coordinator.js empType).
await scenario('G9 · PAKYAW/PEM workers are exempt from AWOL', manila(2026, 7, 21, 8, 0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1007776665554';
  await page.evaluate(() => loadTgFromCloud());
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {}; awolUnsynced = {}; });

  // PEM9001 with a 5+ working-day absence run and NO punches at all — far past the 3-day threshold.
  await page.evaluate(() => { employees = employees.filter(e => e.code === 'PEM9001'); });
  const chain = await page.evaluate(() => collectAbsentDates('PEM9001'));
  await page.evaluate(() => checkAllAbsences());

  const suspended = !!(mock.suspensions['PEM9001'] && mock.suspensions['PEM9001'].active);
  const localBlock = await page.evaluate(() => !!suspendedEmployees['PEM9001']);
  const anyTelegram = mock.telegram.length > 0;
  report('G9a · PEM worker absent 5+ working days → never suspended, no alert, no letter',
    !suspended && !localBlock && !anyTelegram && chain.length >= 5,
    `absentChain=${chain.length} suspendedInDb=${suspended} blockedLocally=${localBlock} telegramSends=${mock.telegram.length}`);

  // The space-separated live spelling must be exempt too ('PEM 0001' on the real roster).
  const bothSpellings = await page.evaluate(() => [isPemCode('PEM 0001'), isPemCode('PEM9001'), isPemCode('RSR0100')]);
  report('G9b · both PEM spellings exempt, RSR not',
    JSON.stringify(bothSpellings) === JSON.stringify([true, true, false]),
    `isPemCode(['PEM 0001','PEM9001','RSR0100']) = ${JSON.stringify(bothSpellings)}`);

  // A PEM worker with a PENDING leave must not even generate the "please decide" HOLD note.
  await page.evaluate(() => {
    leaveRequests.push({ code: 'PEM9001', status: 'Pending', startDate: '07/15/2026', endDate: '07/20/2026' });
  });
  mock.telegram = [];
  await page.evaluate(() => checkAllAbsences());
  const holdFlagged = await page.evaluate(() => !!awolPending['PEM9001']);
  report('G9c · PEM worker with a pending leave gets no HOLD note either',
    mock.telegram.length === 0 && !holdFlagged,
    `telegramSends=${mock.telegram.length} holdFlagged=${holdFlagged}`);
});
```

- [ ] **Step 2: Re-point G8c off PEM9001 (required — it would silently stop guarding)**

In the existing G8 scenario, replace every `PEM9001` with `RSR0303`. `RSR0303` is on the harness roster and is **not** used by G8 cases A (`RSR0100`) or B (`RSR0207`) — each case re-filters `employees` from the shared `window.__g8Roster` snapshot, so reusing a sibling case's code would cross-contaminate the seeded records.

Edit the comment block at ~line 1080 and the case body at ~line 1110:

```js
//   Case C (RSR0303, "today" = a real Monday) — THE OWNER'S EXACT REPORTED BUG, reproduced and locked:
```

```js
  // ── Case C (RSR0303) — the owner's exact reported bug, on a real Monday ──────────────────────
  // NOTE: deliberately an RSR code. This case used to use PEM9001; once PAKYAW/PEM workers became
  // exempt from AWOL (G9), the exemption would fire FIRST and this scenario would pass without ever
  // exercising the Sunday rest-day chain — silently gutting the owner's locked regression guard.
  await page.evaluate(() => { employees = window.__g8Roster.filter(e => e.code === 'RSR0303'); });
  await page.evaluate(thu => {
    records['RSR0303_' + thu] = { punches: { timein: '08:00:00 AM' } }; // worked Thursday → caps the chain
    // Fri/Sat intentionally unseeded → isAbsentOnDate() defaults to absent (no timein, no leave)
    // Sunday intentionally unseeded → moot either way, transparent regardless of a record
  }, thuKey);
  const chainC = await page.evaluate(code => collectAbsentDates(code), 'RSR0303');
  await page.evaluate(() => checkAllAbsences());
  const susC = mock.suspensions['RSR0303'] && mock.suspensions['RSR0303'].active === true;
```

- [ ] **Step 3: Run the harness to verify the new scenario fails**

```bash
node tests/kiosk-stress/kiosk-stress.mjs
```

Expected: `G8c` still PASSes (re-pointed, logic unchanged) and `G9a` FAILs — the PEM worker IS suspended, `suspendedInDb=true`, with a Telegram alert sent. `G9b` FAILs with a page error: `isPemCode is not defined`.

- [ ] **Step 4: Implement the exemption in the kiosk**

In `kiosk/index.html`, immediately above `function isAbsentOnDate(empCode,dateStr){` (line 2224), insert:

```js
// PAKYAW/PEM workers are EXEMPT from AWOL entirely (owner 2026-07-26): piece-rate/casual, so
// irregular attendance is normal for them. The employee CODE PREFIX is the marker — coordinator.js
// sets it at creation time (empType 'RSR' = regular, 'PEM' = pakyaw). Normalized like normCode
// (upper-cased, whitespace stripped) so live 'PEM 0001' and test 'PEM9001' both match. Mirrored
// server-side by awol_is_pem() so no path can suspend a pakyaw worker.
function isPemCode(code){ return /^PEM/.test(String(code||'').replace(/\s/g,'').toUpperCase()); }
```

Then in `checkAllAbsences` (line 2254), add the skip as the **first** check in the loop:

```js
  for(const emp of employees){
    if(isPemCode(emp.code))continue;          // PAKYAW exempt — no suspension, no alert, no HOLD note
    if(suspendedEmployees[emp.code])continue;
    if(onLeaveToday(emp.code))continue;
```

- [ ] **Step 5: Run the harness to verify it passes**

```bash
node tests/kiosk-stress/kiosk-stress.mjs
```

Expected: `G9a`, `G9b`, `G9c` PASS; `G8c` still PASSes; every pre-existing scenario still passes (no count regression).

- [ ] **Step 6: Validate + commit**

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('kiosk/index.html','utf8');const m=[...s.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(x=>x[1]).sort((a,b)=>b.length-a.length)[0];fs.writeFileSync(process.env.TMP+'/kiosk-check.mjs',m);" && node --check "$TMP/kiosk-check.mjs" && echo "kiosk script OK"
grep -c "wpmcbjrisuyjvobvzaus" kiosk/index.html   # must be > 0
grep -c "$OLD_REF" kiosk/index.html   # must be 0
git add kiosk/index.html tests/kiosk-stress/kiosk-stress.mjs
git commit -m "feat(kiosk): PAKYAW/PEM workers exempt from AWOL; re-point G8c off PEM9001"
```

---

## Task 3: Kiosk — remove the one-tap reinstate paths, relabel the leave cancel

**Files:**
- Modify: `kiosk/index.html` — `renderRoster` (~4794), Telegram callback (~4326), `reinstateEmployee`/`sendAwolReinstatedMsg` (~2312–2331), Bisaya modal text (~2047), version stamp (line 238)
- Modify: `tests/kiosk-stress/kiosk-stress.mjs`
- Modify: `preflight.html:38-44`

**Interfaces:**
- Consumes: `isPemCode` (Task 2); `awol_cancel_leave_approved` returning `last_decision='cancelled_leave_approved'` (Task 1).
- Produces: `reinstateEmployee(code, by)` remains defined but is reachable **only** from the leave-approval path; `sendAwolCancelledMsg(code, name, by, res)` replaces `sendAwolReinstatedMsg`.

- [ ] **Step 1: Write the failing harness scenarios**

Add after the G9 scenario:

```js
// G10 — DASHBOARD IS THE ONLY DOOR (owner 2026-07-26): the kiosk keeps the 🚫 Suspended badge but
// has NO reinstate control, and the Telegram reinstate/reject buttons are gone. The only remaining
// kiosk-side un-suspension is the leave-approval auto-cancel, which must be labelled CANCELLED.
await scenario('G10 · kiosk has no reinstate control; leave cancel is labelled CANCELLED', manila(2026, 7, 21, 8, 0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1005554443332';
  await page.evaluate(() => loadTgFromCloud());
  mock.suspensions['RSR0100'] = { employee_code: 'RSR0100', active: true, reason: 'AWOL',
    suspended_on: '07/20/2026', absent_dates: ['2026-07-17','2026-07-18','2026-07-20'],
    awol_group_msg_id: '9001', awol_group_chat: '-1005554443332', letter_received: false };
  await page.evaluate(() => loadSuspensionsFromCloud());
  await page.evaluate(() => renderRoster());

  const rosterHtml = await page.evaluate(() => {
    const c = document.getElementById('roster-list');
    return c ? c.innerHTML : '';
  });
  report('G10a · Staff roster shows the Suspended badge but NO reinstate button',
    /Suspended/.test(rosterHtml) && !/reinstateEmployee\(/.test(rosterHtml) && /RSR Admin dashboard/.test(rosterHtml),
    `hasBadge=${/Suspended/.test(rosterHtml)} hasButton=${/reinstateEmployee\(/.test(rosterHtml)}`);

  // The Telegram callback handler must no longer act on approve_reinstate_* / reject_reinstate_*.
  mock.telegram = [];
  mock.tgCallbacks = [{ id: 'cb1', from: { id: 111, first_name: 'Boss' },
    data: 'approve_reinstate_RSR0100_1', message: { chat: { id: -1005554443332 }, message_id: 9001 } }];
  await page.evaluate(() => pollTelegram());
  const stillBlocked = await page.evaluate(() => !!suspendedEmployees['RSR0100']);
  report('G10b · Telegram approve_reinstate callback no longer reinstates',
    stillBlocked === true && mock.suspensions['RSR0100'].active === true,
    `stillBlockedLocally=${stillBlocked} stillActiveInDb=${mock.suspensions['RSR0100'].active}`);

  // Leave approval still clears the block — and says CANCELLED, not reinstated.
  mock.telegram = [];
  await page.evaluate(() => reinstateEmployee('RSR0100', 'leave approved'));
  const texts = mock.telegram.map(t => t.text || '').join(' || ');
  report('G10c · leave-approval cancel posts CANCELLED and edits the original alert',
    /CANCELLED/i.test(texts) && !/REINSTATED/i.test(texts) && mock.suspensions['RSR0100'].active === false,
    `sends=${texts}`);
});
```

The `mock.tgCallbacks` hook above needs a mocked `getUpdates`. If the harness does not already have one, add it alongside the other Telegram mocks, and initialise `mock.tgCallbacks = []` in `scenario()` next to `mock.suspensions = {}`:

```js
      if (p.includes('/getUpdates')) {
        const cbs = mock.tgCallbacks || [];
        mock.tgCallbacks = [];
        return json(200, { ok: true, result: cbs.map((c, i) => ({ update_id: i + 1, callback_query: c })) });
      }
```

- [ ] **Step 2: Run to verify failure**

```bash
node tests/kiosk-stress/kiosk-stress.mjs
```

Expected: `G10a` FAILs (the roster still renders `reinstateEmployee(`), `G10b` FAILs (the callback still reinstates), `G10c` FAILs (the message says "Reinstated").

- [ ] **Step 3: Remove the roster reinstate button**

In `renderRoster` (~4794), replace the badge/button block with:

```js
        ${suspendedEmployees[emp.code]?`<span style="background:#FCEBEB;color:#A32D2D;font-size:10px;font-weight:600;padding:3px 8px;border-radius:6px">🚫 Suspended</span>`:''}
        <button onclick="openEditModal('${emp.code}')" style="background:#E6F1FB;border:none;color:#185FA5;cursor:pointer;font-size:11px;font-weight:600;padding:5px 12px;border-radius:8px">Edit</button>
        <button onclick="removeEmployee('${emp.code}')" style="background:#FCEBEB;border:none;color:#A32D2D;cursor:pointer;font-size:11px;font-weight:600;padding:5px 12px;border-radius:8px">Remove</button>
        ${suspendedEmployees[emp.code]?`<span style="color:#6B7280;font-size:10px;font-weight:600;align-self:center">Reinstate on the RSR Admin dashboard</span>`:''}
      </div>`;
```

The `<button onclick="reinstateEmployee(...)">` is deleted outright — reinstatement is now the dashboard's two-step flow only.

- [ ] **Step 4: Remove the Telegram reinstate callback branch**

Replace the whole `} else if(reqType==='reinstate'){ … }` block (~4326–4339) with:

```js
      } else if(reqType==='reinstate'){
        // (2026-07-26) Reinstatement moved to the RSR Admin dashboard's two-step gate (coordinator
        // confirms the letter, admin approves). Old inline buttons are inert — answer and do nothing.
        await tgAnswerCallback(cb.id,'Reinstatement is now done on the RSR Admin dashboard.');
      }
```

- [ ] **Step 5: Relabel the leave-approval cancel**

Replace `reinstateEmployee` and `sendAwolReinstatedMsg` (~2312–2331) with:

```js
// (2026-07-26) The ONLY kiosk-side un-suspension left: the leave-approval auto-cancel. An absence
// later covered by an APPROVED leave means the suspension was issued in error, so it clears with no
// letter and no two-step — and is logged as CANCELLED, never as a reinstatement. Every other path
// now goes through the dashboard gate (awol_letter_received → awol_admin_decide).
async function reinstateEmployee(code,by){
  let res=null;
  try{ const {data}=await sbClient.rpc('awol_cancel_leave_approved',{p_code:code,p_by:by||'leave approved',p_on:todayKey()}); res=data; }
  catch(e){ res=null; }
  const newly = res ? (res.newly!==false) : true; // offline → assume newly so the local block clears
  delete suspendedEmployees[code];
  delete awolUnsynced[code]; saveAwolUnsynced();
  saveData();renderRoster();updateStats();
  const nm=employees.find(e=>e.code===code)?.name||code;
  logNotif(`↩️ ${nm} — suspension cancelled (leave approved)`,'',true);
  if(newly) await sendAwolCancelledMsg(code,nm,by||'leave approved',res);
  loadSuspensionsFromCloud();
}
async function sendAwolCancelledMsg(code,name,by,res){
  if(!tgToken||tgToken.length<20)return;
  const t=awolTarget();
  if(t) await tgSendText(t,`↩️ <b>CANCELLED — leave approved</b>\n👤 ${name} (${code}) — cleared on ${todayKey()}\nThe absence was covered by an approved leave, so the suspension was issued in error.`);
  const chat=res&&res.awol_group_chat, mid=res&&res.awol_group_msg_id;
  if(chat&&mid){ try{ await tgEditMessage(chat,mid,`↩️ CANCELLED — ${name}: leave approved ${todayKey()}`);}catch(e){} }
}
```

- [ ] **Step 6: Update the Bisaya modal text**

At ~2047, replace the `showBisayaModal(...)` argument with the owner-approved copy:

```js
        showBisayaModal('GI-SUSPEND ANG IMONG ACCOUNT\n\nAbsent ka og 3+ ka adlaw nga sunod-sunod nga walay approved nga leave.\n\nKuhaa ug sulati ang AWOL letter, ihatag sa coordinator, dayon hulaton ang approval sa admin una ka maka-punch.');
```

- [ ] **Step 7: Bump the version stamps in lockstep**

`kiosk/index.html:238` → `<span id="version-stamp">v2026-07-26a</span>`

`preflight.html:38` → `'kiosk/index.html':'v2026-07-26a',`

- [ ] **Step 8: Run the harness to verify it passes**

```bash
node tests/kiosk-stress/kiosk-stress.mjs
```

Expected: `G10a/b/c` PASS, `G9*` and `G8*` still PASS, no pre-existing scenario regresses.

- [ ] **Step 9: Validate + commit**

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('kiosk/index.html','utf8');const m=[...s.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(x=>x[1]).sort((a,b)=>b.length-a.length)[0];fs.writeFileSync(process.env.TMP+'/kiosk-check.mjs',m);" && node --check "$TMP/kiosk-check.mjs" && echo "kiosk script OK"
grep -c "$OLD_REF" kiosk/index.html preflight.html   # both must be 0
git add kiosk/index.html preflight.html tests/kiosk-stress/kiosk-stress.mjs
git commit -m "feat(kiosk): dashboard is the only reinstate door; leave cancel relabelled CANCELLED (v2026-07-26a)"
```

---

## Task 4: Coordinator page — step 1, the letter tick

**Files:**
- Modify: `coordinator.js` — new `awol` area (menu ~1565, router ~1600), new `AwolLetters` component, new `notifyAwol` helper
- Create: `tests/awol-dashboard/dashboard-awol.smoke.mjs`

**Interfaces:**
- Consumes: `awol_clerk_for_pin(p_pin) → {ok, code, name}`, `awol_letter_received(p_code, p_by) → {newly}` (Task 1).
- Produces: `notifyAwol(text)` in `coordinator.js` scope — posts to `tg_awol_group`, falling back to `mgr_ids`.

- [ ] **Step 1: Write the failing smoke test**

Create `tests/awol-dashboard/dashboard-awol.smoke.mjs`:

```js
// Playwright smoke over the coordinator + admin AWOL surfaces with Supabase fully mocked.
// Nothing here touches the live project — the real host is walled off.
// Run: node tests/awol-dashboard/dashboard-awol.smoke.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const FORBIDDEN_HOST = 'wpmcbjrisuyjvobvzaus.supabase.co';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const state = {
  suspensions: {},
  events: [],
  rpcCalls: [],
  clerkPin: '250250',              // Jamaica's PIN in this mock
};
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${name}${detail ? `\n        ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const idx = path.join(file, 'index.html');
    if (fs.existsSync(idx)) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(idx)); }
    res.writeHead(404); return res.end('nope');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}).listen(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.route('**/*', (route) => {
  const url = route.request().url();
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.includes(FORBIDDEN_HOST)) {
    const u = new URL(url), p = u.pathname;
    let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
    if (p.endsWith('/rest/v1/rpc/awol_clerk_for_pin')) {
      state.rpcCalls.push(['clerk', body.p_pin]);
      return json(200, body.p_pin === state.clerkPin
        ? { ok: true, code: 'RSR 0025', name: 'Jamaica L. Batucan' } : { ok: false });
    }
    if (p.endsWith('/rest/v1/rpc/awol_letter_received')) {
      state.rpcCalls.push(['letter', body.p_code, body.p_by]);
      const r = state.suspensions[body.p_code];
      if (!r || !r.active || r.letter_received) return json(200, { newly: false });
      r.letter_received = true; r.letter_received_by = body.p_by;
      return json(200, { newly: true });
    }
    if (p.endsWith('/rest/v1/rpc/awol_admin_decide')) {
      state.rpcCalls.push(['decide', body.p_code, body.p_decision]);
      const r = state.suspensions[body.p_code];
      if (!r || !r.active) return json(200, { newly: false, reason: 'not currently suspended' });
      if (body.p_decision === 'approve') {
        if (!r.letter_received) return json(200, { newly: false, reason: 'letter not yet confirmed' });
        r.active = false; r.last_decision = 'approved';
        return json(200, { newly: true, awol_group_msg_id: r.awol_group_msg_id, awol_group_chat: r.awol_group_chat });
      }
      r.letter_received = false; r.last_decision = 'kept';
      return json(200, { newly: true, kept: true });
    }
    if (p.endsWith('/rest/v1/rpc/admin_verify_passcode')) return json(200, body.p_input === '123456');
    if (p.endsWith('/rest/v1/rpc/awol_manual_suspend')) {
      state.rpcCalls.push(['manual', body.p_code, !!body.p_letter_on_file]);
      if (!Array.isArray(body.p_dates) || !body.p_dates.length) return json(200, { newly: false, reason: 'at least one absent date is required' });
      state.suspensions[body.p_code] = { employee_code: body.p_code, active: true, reason: body.p_reason,
        absent_dates: body.p_dates, letter_received: !!body.p_letter_on_file, manual: true, ref_note: body.p_ref_note };
      return json(200, { newly: true });
    }
    if (p.endsWith('/rest/v1/employee_suspensions')) {
      const wantsInactive = /active=eq\.false/.test(u.search);
      return json(200, Object.values(state.suspensions).filter(r => wantsInactive ? !r.active : r.active));
    }
    if (p.endsWith('/rest/v1/awol_events')) return json(200, state.events);
    if (p.endsWith('/rest/v1/employees')) return json(200, [
      { id: 'u1', code: 'RSR 0006', name: 'Baby Monterola', position: 'Fitter', home_site: 'Mandaue', pin: '660660', is_issuer: false },
      { id: 'u2', code: 'RSR 0025', name: 'Jamaica L. Batucan', position: 'Office', home_site: 'Carmen', pin: '250250', is_issuer: true },
      { id: 'u3', code: 'PEM 0001', name: 'Julius', position: 'Fitter', home_site: 'Carmen', pin: '500500', is_issuer: false },
    ]);
    if (p.endsWith('/rest/v1/settings')) return json(200, [
      { key: 'coordinator_pin', value: '1234' },
      { key: 'tg_token', value: 'TESTTOKEN0000000000000000000000000000' },
      { key: 'tg_awol_group', value: '-1001112223334' },
      { key: 'mgr_ids', value: '111,222' },
    ]);
    return json(200, []);
  }
  if (url.includes('api.telegram.org')) return json(200, { ok: true, result: { message_id: 4242 } });
  if (url.startsWith(base) || url.startsWith('data:')) return route.continue();
  return json(200, []);
});

// ── coordinator page: only Jamaica's PIN may tick ───────────────────────────────
state.suspensions['RSR 0006'] = { employee_code: 'RSR 0006', active: true, reason: 'Absent 3 consecutive days',
  suspended_on: '07/26/2026', absent_dates: ['2026-07-22','2026-07-23','2026-07-24'],
  letter_received: false, awol_group_msg_id: '9001', awol_group_chat: '-1001112223334' };

const coord = await context.newPage();
await coord.goto(`${base}/coordinator/`, { waitUntil: 'networkidle' });
await coord.fill('input[type=password]', '1234');
await coord.click('button:has-text("Unlock")');
await coord.click('text=AWOL — letters');
await coord.waitForSelector('text=Baby Monterola');
check('coordinator: suspended worker appears in "Waiting for the letter"',
  await coord.isVisible('text=Baby Monterola'));

await coord.click('button:has-text("Letter received")');
await coord.fill('input[data-awol-pin]', '660660');            // Baby's own PIN — must be refused
await coord.click('button:has-text("Confirm")');
await coord.waitForSelector('text=not authorised');
check('coordinator: a non-clerk PIN is refused with the neutral message',
  await coord.isVisible('text=This PIN is not authorised for the AWOL letter step') &&
  state.suspensions['RSR 0006'].letter_received === false);

await coord.fill('input[data-awol-pin]', '250250');            // Jamaica's PIN
await coord.click('button:has-text("Confirm")');
await coord.waitForSelector('text=WITH ADMIN');
check("coordinator: Jamaica's PIN ticks the letter and records her name",
  state.suspensions['RSR 0006'].letter_received === true &&
  state.suspensions['RSR 0006'].letter_received_by === 'Jamaica L. Batucan',
  `letter_received_by=${state.suspensions['RSR 0006'].letter_received_by}`);
check('coordinator: no Undo control exists', !(await coord.isVisible('button:has-text("Undo")')));

// ── admin dashboard: gate + decisions ──────────────────────────────────────────
const admin = await context.newPage();
await admin.goto(`${base}/admin/`, { waitUntil: 'networkidle' });
for (const d of '123456') await admin.click(`button:has-text("${d}")`);
await admin.waitForSelector('text=AWOL — suspensions');
check('admin: ticked case shows under "Needs your decision"',
  await admin.isVisible('text=Needs your decision'));

await admin.click('button:has-text("Keep suspended")');
for (const d of '123456') await admin.click(`button[data-admin-key="${d}"]`);
await admin.waitForSelector('text=Waiting for the letter');
check('admin: keep-suspended clears the tick and the worker stays blocked',
  state.suspensions['RSR 0006'].active === true && state.suspensions['RSR 0006'].letter_received === false);
check('admin: no Approve button while the case is waiting for the letter',
  !(await admin.isVisible('button:has-text("Approve")')));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run to verify failure**

```bash
node tests/awol-dashboard/dashboard-awol.smoke.mjs
```

Expected: FAIL at `await coord.click('text=AWOL — letters')` — timeout, the area does not exist.

- [ ] **Step 3: Add the AWOL Telegram sender to `coordinator.js`**

Immediately after the existing `notifyTg` function (~line 246):

```js
// AWOL group notifier — posts to the dedicated AWOL group, falling back to the manager DMs while
// the group chat id is unset so an alert is never silently dropped.
async function notifyAwol(text) {
  try {
    const token = await getSetting('tg_token');
    if (!token) return;
    const grp = (await getSetting('tg_awol_group')) || '';
    const targets = grp ? [grp] : String((await getSetting('mgr_ids')) || '').split(',').map(s => s.trim()).filter(Boolean);
    await Promise.all(targets.map(id => fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: id, text, parse_mode: 'HTML' }),
    }).catch(() => {})));
  } catch (_) {}
}
```

- [ ] **Step 4: Add the `AwolLetters` component**

Insert before the top-level `App` component (before ~line 1520):

```js
// ---------- AWOL letters (step 1 of the reinstate gate) ----------
// The coordinator page can CONFIRM a letter but can never unblock anyone. Only the employee flagged
// is_awol_clerk (RSR 0025 Jamaica) may tick, verified server-side by awol_clerk_for_pin — the shared
// coordinator passcode that opened this page is deliberately not enough.
function AwolLetters({ toast, employees }) {
  const [rows, setRows] = useState(null);
  const [pinFor, setPinFor] = useState(null);   // employee_code awaiting a PIN, or null
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // employee_suspensions stores neither the name nor the yard — enrich from the loaded roster.
  const load = async () => {
    try {
      const { data, error } = await supabase.from('employee_suspensions').select('*').eq('active', true);
      if (error) throw error;
      const byCode = {};
      (employees || []).forEach(e => { byCode[String(e.code).replace(/\s/g, '').toUpperCase()] = e; });
      setRows((data || []).map(r => {
        const e = byCode[String(r.employee_code).replace(/\s/g, '').toUpperCase()];
        return { ...r, emp_name: e ? e.name : r.employee_code, yard: e ? siteNorm(e.home_site) : '' };
      }));
    } catch (e) { setRows([]); toast('Could not load suspensions: ' + e.message, true); }
  };
  useEffect(() => { load(); }, []);

  const letterUrl = (r) => {
    const b = location.origin + location.pathname.replace(/\/coordinator(\/.*)?$/, '');
    const q = new URLSearchParams({
      name: r.emp_name || r.employee_code, code: r.employee_code, yard: r.yard || '',
      dates: (Array.isArray(r.absent_dates) ? r.absent_dates : []).join(','),
      pdate: r.suspended_on || '',
    });
    return `${b}/awol-letter.html?${q.toString()}`;
  };

  const confirmTick = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const { data: who, error: e1 } = await supabase.rpc('awol_clerk_for_pin', { p_pin: pin });
      if (e1) throw e1;
      if (!who || who.ok !== true) { setErr('This PIN is not authorised for the AWOL letter step'); setPin(''); return; }
      const { data: res, error: e2 } = await supabase.rpc('awol_letter_received', { p_code: pinFor, p_by: who.name });
      if (e2) throw e2;
      const row = (rows || []).find(r => r.employee_code === pinFor);
      if (res && res.newly === true) {
        await notifyAwol(`📄 <b>Letter received</b>\n👤 ${(row && row.emp_name) || pinFor} (${pinFor})\nConfirmed by ${who.name} · waiting for admin approval`);
      }
      setPinFor(null); setPin('');
      toast('Letter confirmed — it is with the admin now');
      await load();
    } catch (e) { setErr('Could not confirm — check the connection and try again.'); }
    finally { setBusy(false); }
  };

  if (rows == null) return html`<div class="card"><div class="empty">Loading…</div></div>`;
  const waiting = rows.filter(r => !r.letter_received);
  const withBoss = rows.filter(r => r.letter_received);

  return html`
    <div class="card">
      <label>Waiting for the letter (${waiting.length})</label>
      ${waiting.length ? waiting.map(r => html`
        <div class="row" key=${r.employee_code} style="align-items:flex-start">
          <div>
            <div class="name">${r.emp_name || r.employee_code}</div>
            <div class="unit">${r.employee_code}${r.yard ? ' · ' + r.yard : ''} · suspended ${r.suspended_on || '—'}</div>
            <div class="unit">Absent: ${(Array.isArray(r.absent_dates) ? r.absent_dates : []).join(', ') || '—'}</div>
            ${r.ref_note ? html`<div class="unit">${r.ref_note}</div>` : ''}
            <a class="unit" href=${letterUrl(r)} target="_blank" rel="noopener">Open / print letter →</a>
          </div>
          <button class="btn" onClick=${() => { setPinFor(r.employee_code); setPin(''); setErr(''); }}>Letter received</button>
        </div>`)
        : html`<div class="empty">Nobody is waiting for a letter.</div>`}
    </div>

    ${pinFor && html`
      <div class="card" style="border-color:var(--hivis)">
        <label>Confirm with your own passcode</label>
        <p class="note" style="margin:0 0 10px">Only the person authorised for AWOL letters can confirm this. Your name is recorded on the case.</p>
        <${Field} label="Your passcode">
          <input data-awol-pin type="password" inputmode="numeric" value=${pin}
            onInput=${e => setPin(e.target.value)}
            onKeyDown=${e => { if (e.key === 'Enter') confirmTick(); }} />
        <//>
        <div style="display:flex;gap:8px">
          <button class="btn" disabled=${busy} onClick=${confirmTick}>${busy ? 'Checking…' : 'Confirm'}</button>
          <button class="btn ghost" disabled=${busy} onClick=${() => { setPinFor(null); setPin(''); setErr(''); }}>Cancel</button>
        </div>
        ${err && html`<p class="note" style="margin-top:10px;color:var(--warn)">${err}</p>`}
      </div>`}

    <div class="card">
      <label>Waiting for the boss (${withBoss.length})</label>
      ${withBoss.length ? withBoss.map(r => html`
        <div class="row" key=${r.employee_code} style="align-items:flex-start">
          <div>
            <div class="name">${r.emp_name || r.employee_code}</div>
            <div class="unit">${r.employee_code} · letter confirmed by ${r.letter_received_by || '—'}</div>
          </div>
          <span class="badge">WITH ADMIN</span>
        </div>`)
        : html`<div class="empty">Nothing waiting with the admin.</div>`}
      <p class="note" style="margin-top:10px">Only the admin can lift a suspension. This page confirms the letter only.</p>
    </div>`;
}
```

- [ ] **Step 5: Wire the area into the menu and the router**

In the area menu (~1565), after the Roll-call card:

```js
        <div class="card" style="cursor:pointer;margin:0;grid-column:1/-1" onClick=${() => setArea('awol')}>
          <div style="font-size:24px">📄</div><div class="name" style="font-size:15px;margin-top:6px;font-weight:700">AWOL — letters</div>
          <div class="sub" style="font-size:12px;color:var(--ink-dim)">Confirm a received AWOL letter · admin approves after</div>
        </div>
```

In the `Header(...)` title expression (~1601), add `area === 'awol' ? 'AWOL — LETTERS' :` to the chain, and in the area router add:

```js
      ${area === 'awol' && html`<${AwolLetters} toast=${flash} employees=${employees} />`}
```

- [ ] **Step 6: Run the smoke test — the coordinator half must pass**

```bash
node tests/awol-dashboard/dashboard-awol.smoke.mjs
```

Expected: the four coordinator checks PASS; the admin checks still FAIL (`AWOL — suspensions` does not exist yet — that is Task 5).

- [ ] **Step 7: Validate + commit**

```bash
node --check coordinator.js && echo "coordinator.js OK"
grep -c "$OLD_REF" coordinator.js   # must be 0
git add coordinator.js tests/awol-dashboard/dashboard-awol.smoke.mjs
git commit -m "feat(coordinator): AWOL letters card — clerk-PIN letter tick (step 1 of the reinstate gate)"
```

---

## Task 5: Dashboard — step 2, the admin decision

**Files:**
- Modify: `home.js` — `AwolSuspensions` component, Telegram helpers, render after `${healthBanner()}` (line 1575)

**Interfaces:**
- Consumes: `awol_admin_decide`, `awol_letter_received` (Task 1), `admin_verify_passcode` (existing).
- Produces: `notifyAwol(text)` and `editAwolMsg(chat, msgId, text)` in `home.js` scope, reused by Task 6.

- [ ] **Step 1: Confirm the admin half of the smoke test fails**

```bash
node tests/awol-dashboard/dashboard-awol.smoke.mjs
```

Expected: FAIL at `await admin.waitForSelector('text=AWOL — suspensions')`.

- [ ] **Step 2: Add the Telegram helpers to `home.js`**

After `countRows` (~line 26). If `home.js` already defines an equivalent `getSetting`, reuse it and drop `getSettingRaw`:

```js
// AWOL group notifier — the dashboard posts its own decision messages so the log always shows who
// acted. Falls back to the manager DMs while tg_awol_group is unset, so nothing is silently dropped.
async function getSettingRaw(key) {
  try {
    const { data, error } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
    if (error) throw error;
    return data ? data.value : null;
  } catch (_) { return null; }
}
async function notifyAwol(text) {
  const token = await getSettingRaw('tg_token');
  if (!token) return;
  const grp = (await getSettingRaw('tg_awol_group')) || '';
  const targets = grp ? [grp] : String((await getSettingRaw('mgr_ids')) || '').split(',').map(s => s.trim()).filter(Boolean);
  await Promise.all(targets.map(id => fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: id, text, parse_mode: 'HTML' }),
  }).catch(() => {})));
}
// Edit the ORIGINAL 🚨 alert so the group reads as a running open/resolved log.
async function editAwolMsg(chat, msgId, text) {
  if (!chat || !msgId) return;
  const token = await getSettingRaw('tg_token');
  if (!token) return;
  await fetch('https://api.telegram.org/bot' + token + '/editMessageText', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, message_id: msgId, text, parse_mode: 'HTML' }),
  }).catch(() => {});
}
```

- [ ] **Step 3: Add the `AwolSuspensions` component**

Insert before the `Tile` component (~line 310):

```js
// ---------- AWOL suspensions (step 2 of the reinstate gate) ----------
// The dashboard is the ONLY door back: the kiosk and Telegram one-tap buttons were removed. The
// admin PIN is re-verified on EVERY decision — it is the signature, not a session unlock — and
// awol_admin_decide refuses to approve unless the letter has been confirmed, so a stale screen
// cannot slip one through.
function AwolSuspensions({ emps, flash }) {
  const [rows, setRows] = useState(null);
  const [closedRows, setClosedRows] = useState([]);
  const [closed, setClosed] = useState([]);
  const [ask, setAsk] = useState(null);   // {code, name, decision:'approve'|'keep'|'tick'|'manual', …}
  const [manual, setManual] = useState(null);
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const byCode = {};
  (emps || []).forEach(e => { byCode[String(e.code).replace(/\s/g, '').toUpperCase()] = e; });
  const nameOf = (code) => { const e = byCode[String(code).replace(/\s/g, '').toUpperCase()]; return e ? e.name : code; };
  const yardOf = (code) => { const e = byCode[String(code).replace(/\s/g, '').toUpperCase()]; return e ? siteNorm(e.home_site) : ''; };

  const load = async () => {
    try {
      const { data, error } = await supabase.from('employee_suspensions').select('*').eq('active', true);
      if (error) throw error;
      setRows(data || []);
    } catch (_) { setRows([]); }
    try {
      const { data } = await supabase.from('employee_suspensions').select('*').eq('active', false).limit(50);
      setClosedRows(data || []);
    } catch (_) { setClosedRows([]); }
    try {
      const { data } = await supabase.from('awol_events').select('*')
        .in('event', ['reinstated', 'kept_suspended', 'cancelled_leave_approved'])
        .order('at', { ascending: false }).limit(10);
      setClosed(data || []);
    } catch (_) { setClosed([]); }
  };
  useEffect(() => { load(); }, []);

  const letterUrl = (r) => {
    const b = location.origin + location.pathname.replace(/\/admin(\/.*)?$/, '');
    const q = new URLSearchParams({
      name: nameOf(r.employee_code), code: r.employee_code, yard: yardOf(r.employee_code),
      dates: (Array.isArray(r.absent_dates) ? r.absent_dates : []).join(','), pdate: r.suspended_on || '',
    });
    return `${b}/awol-letter.html?${q.toString()}`;
  };

  const run = async () => {
    if (busy || !ask) return;
    setBusy(true); setErr('');
    try {
      const { data: ok, error: e1 } = await supabase.rpc('admin_verify_passcode', { p_input: pin });
      if (e1) throw e1;
      if (ok !== true) { setErr('Wrong PIN.'); setPin(''); return; }
      const actor = localStorage.getItem('rsr_prepared_by') || 'Admin';
      const nm = ask.name, code = ask.code;
      const today = new Date().toLocaleDateString('en-PH');

      if (ask.decision === 'tick') {
        const { data: res } = await supabase.rpc('awol_letter_received', { p_code: code, p_by: 'Admin — ' + actor });
        if (res && res.newly === true) {
          await notifyAwol(`📄 <b>Letter received</b>\n👤 ${nm} (${code})\nConfirmed by Admin — ${actor} · waiting for admin approval`);
        }
        flash('Letter confirmed');
      } else if (ask.decision === 'approve') {
        const { data: res } = await supabase.rpc('awol_admin_decide', { p_code: code, p_by: actor, p_decision: 'approve' });
        if (!res || res.newly !== true) { setErr(res && res.reason ? res.reason : 'Could not approve.'); return; }
        await notifyAwol(`✅ <b>REINSTATED</b>\n👤 ${nm} (${code}) — approved by ${actor} on ${today}`);
        await editAwolMsg(res.awol_group_chat, res.awol_group_msg_id, `✅ RESOLVED — ${nm} reinstated ${today}`);
        flash(nm + ' can punch again');
      } else if (ask.decision === 'keep') {
        const { data: res } = await supabase.rpc('awol_admin_decide', { p_code: code, p_by: actor, p_decision: 'keep' });
        if (!res || res.newly !== true) { setErr(res && res.reason ? res.reason : 'Could not save.'); return; }
        await notifyAwol(`⛔ <b>Kept suspended</b>\n👤 ${nm} (${code}) — decided by ${actor} on ${today} · letter step reset`);
        flash(nm + ' stays suspended');
      }
      setAsk(null); setPin('');
      await load();
    } catch (_) { setErr('Could not save — check the connection and try again.'); }
    finally { setBusy(false); }
  };

  if (rows == null) return '';
  const needsDecision = rows.filter(r => r.letter_received);
  const waitingLetter = rows.filter(r => !r.letter_received);

  const line = (r) => html`
    <div>
      <div class="name">${nameOf(r.employee_code)}</div>
      <div class="unit">${r.employee_code}${yardOf(r.employee_code) ? ' · ' + yardOf(r.employee_code) : ''} · suspended ${r.suspended_on || '—'}</div>
      <div class="unit">Absent: ${(Array.isArray(r.absent_dates) ? r.absent_dates : []).join(', ') || '—'}</div>
      ${r.letter_received ? html`<div class="unit">Letter confirmed by ${r.letter_received_by || '—'}</div>` : ''}
      ${r.ref_note ? html`<div class="unit" style="color:var(--hivis)">${r.ref_note}</div>` : ''}
      <a class="unit" href=${letterUrl(r)} target="_blank" rel="noopener">Open / print letter →</a>
    </div>`;

  return html`
    <div class="card" style=${needsDecision.length ? 'border-color:var(--hivis)' : ''}>
      <label>AWOL — suspensions</label>

      <div class="sectlabel" style="margin-top:0">Needs your decision (${needsDecision.length})</div>
      ${needsDecision.length ? needsDecision.map(r => html`
        <div class="row" key=${r.employee_code} style="align-items:flex-start">
          ${line(r)}
          <span style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn" onClick=${() => { setAsk({ code: r.employee_code, name: nameOf(r.employee_code), decision: 'approve' }); setPin(''); setErr(''); }}>✅ Approve — worker can punch</button>
            <button class="btn ghost" onClick=${() => { setAsk({ code: r.employee_code, name: nameOf(r.employee_code), decision: 'keep' }); setPin(''); setErr(''); }}>⛔ Keep suspended</button>
          </span>
        </div>`)
        : html`<div class="empty">Nothing waiting on you.</div>`}

      <div class="sectlabel">Waiting for the letter (${waitingLetter.length})</div>
      ${waitingLetter.length ? waitingLetter.map(r => html`
        <div class="row" key=${r.employee_code} style="align-items:flex-start">
          ${line(r)}
          <button class="btn ghost" onClick=${() => { setAsk({ code: r.employee_code, name: nameOf(r.employee_code), decision: 'tick' }); setPin(''); setErr(''); }}>Tick letter received (admin)</button>
        </div>`)
        : html`<div class="empty">Nobody outstanding.</div>`}

      <div class="sectlabel">Recently closed</div>
      ${closed.length ? closed.map(e => html`
        <div class="row" key=${e.id}>
          <div>
            <div class="name">${nameOf(e.employee_code)}</div>
            <div class="unit">${e.event === 'reinstated' ? 'Approved' : e.event === 'kept_suspended' ? 'Kept suspended' : 'Cancelled — leave approved'} · ${e.actor || '—'} · ${e.at ? new Date(e.at).toLocaleDateString('en-PH') : ''}</div>
          </div>
        </div>`)
        : html`<div class="empty">No closed cases yet.</div>`}
    </div>

    ${ask && html`
      <div class="card" style="border-color:var(--hivis)">
        <label>${ask.decision === 'approve' ? 'Approve ' + ask.name : ask.decision === 'keep' ? 'Keep ' + ask.name + ' suspended' : ask.decision === 'manual' ? 'Suspend ' + ask.name : 'Confirm the letter for ' + ask.name}</label>
        <p class="note" style="margin:0 0 10px">Enter the 6-digit admin PIN to sign this decision.</p>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-width:280px">
          ${['1','2','3','4','5','6','7','8','9','0'].map(d => html`
            <button class="btn ghost" data-admin-key=${d} disabled=${busy}
              onClick=${() => { const n = (pin + d).slice(0, 6); setPin(n); if (n.length === 6) setTimeout(run, 0); }}>${d}</button>`)}
          <button class="btn ghost" disabled=${busy} onClick=${() => setPin(p => p.slice(0, -1))}>⌫</button>
        </div>
        <p class="note" style="margin-top:10px">${'•'.repeat(pin.length)}</p>
        <button class="btn ghost" disabled=${busy} onClick=${() => { setAsk(null); setPin(''); setErr(''); }}>Cancel</button>
        ${err && html`<p class="note" style="margin-top:10px;color:var(--warn)">${err}</p>`}
      </div>`}`;
}
```

- [ ] **Step 4: Render it on the dashboard**

At line 1575, immediately after `${healthBanner()}`:

```js
      ${healthBanner()}
      <${AwolSuspensions} emps=${emps} flash=${flash} />
```

- [ ] **Step 5: Run the smoke test**

```bash
node tests/awol-dashboard/dashboard-awol.smoke.mjs
```

Expected: all checks PASS, including "no Approve button while the case is waiting for the letter".

- [ ] **Step 6: Validate + commit**

```bash
node --check home.js && echo "home.js OK"
grep -c "$OLD_REF" home.js   # must be 0
git add home.js
git commit -m "feat(dashboard): AWOL suspensions card — PIN-signed approve/keep + admin fallback tick"
```

---

## Task 6: Dashboard — manual suspension and re-suspension

**Files:**
- Modify: `home.js` — extend `AwolSuspensions`
- Modify: `tests/awol-dashboard/dashboard-awol.smoke.mjs`

**Interfaces:**
- Consumes: `awol_manual_suspend(p_code, p_by, p_reason, p_dates, p_ref_note, p_letter_on_file)` (Task 1), `notifyAwol` (Task 5).

- [ ] **Step 1: Write the failing checks**

Append to `tests/awol-dashboard/dashboard-awol.smoke.mjs`, before `await browser.close()`:

```js
// ── manual re-suspension (wrong-approval recovery) ─────────────────────────────
state.suspensions['RSR 0006'].letter_received = true;
state.events.push({ id: 1, employee_code: 'RSR 0006', event: 'reinstated', actor: 'Admin', at: '2026-07-26T02:00:00Z' });
await admin.reload({ waitUntil: 'networkidle' });
for (const d of '123456') await admin.click(`button:has-text("${d}")`);
await admin.click('button:has-text("Approve")');
for (const d of '123456') await admin.click(`button[data-admin-key="${d}"]`);
await admin.waitForSelector('text=Nothing waiting on you');
check('admin: approve closes the case', state.suspensions['RSR 0006'].active === false);

await admin.click('button:has-text("Re-suspend (letter on file)")');
for (const d of '123456') await admin.click(`button[data-admin-key="${d}"]`);
await admin.waitForSelector('text=Needs your decision');
check('admin: re-suspension carries the letter forward and lands at "needs decision"',
  state.suspensions['RSR 0006'].active === true &&
  state.suspensions['RSR 0006'].letter_received === true &&
  /letter already on file/i.test(state.suspensions['RSR 0006'].ref_note || ''),
  JSON.stringify(state.suspensions['RSR 0006']));

// ── manual suspension: PEM workers must not be offered ─────────────────────────
await admin.click('button:has-text("Suspend someone manually")');
const options = await admin.$$eval('select[data-manual-emp] option', els => els.map(e => e.value));
check('admin: PEM workers are not listed for manual suspension',
  !options.some(v => /^PEM/i.test(String(v).replace(/\s/g, ''))) && options.some(v => /RSR/.test(v)),
  `options=${JSON.stringify(options)}`);

// ── manual suspension: at least one date is required ───────────────────────────
await admin.selectOption('select[data-manual-emp]', 'RSR 0025');
await admin.fill('input[data-manual-reason]', 'no-show, no contact');
await admin.fill('input[data-manual-dates]', '');
await admin.click('button:has-text("Create suspension")');
for (const d of '123456') await admin.click(`button[data-admin-key="${d}"]`);
await admin.waitForSelector('text=at least one absent date');
check('admin: manual suspension refused with no dates',
  !state.suspensions['RSR 0025'] || state.suspensions['RSR 0025'].active !== true);
```

- [ ] **Step 2: Run to verify failure**

```bash
node tests/awol-dashboard/dashboard-awol.smoke.mjs
```

Expected: FAIL at `button:has-text("Re-suspend (letter on file)")` — the control does not exist.

- [ ] **Step 3: Add the manual branch to `run()`**

Inside `AwolSuspensions.run()`, add this branch immediately after the `ask.decision === 'keep'` branch:

```js
      } else if (ask.decision === 'manual') {
        const dates = String(ask.dates || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!dates.length) { setErr('at least one absent date is required'); return; }
        const { data: res } = await supabase.rpc('awol_manual_suspend', {
          p_code: code, p_by: actor, p_reason: ask.reason || 'Manual suspension',
          p_dates: dates, p_ref_note: ask.refNote || null, p_letter_on_file: !!ask.letterOnFile,
        });
        if (!res || res.newly !== true) { setErr(res && res.reason ? res.reason : 'Could not suspend.'); return; }
        const kind = ask.letterOnFile ? 'Suspended (manual re-suspension)' : 'Suspended (manual)';
        await notifyAwol(`🚨 <b>AWOL — ${kind}</b>\n👤 ${nm} (${code})\n📅 Absent: ${dates.join(', ')}\nReason: ${ask.reason || '—'}${ask.refNote ? `\n↩️ ${ask.refNote}` : ''}`);
        setManual(null);
        flash(nm + ' is suspended');
      }
```

- [ ] **Step 4: Add the Re-suspend control to each closed row**

Inside the `closed.map(...)` row, after the inner `<div>`:

```js
          ${e.event !== 'cancelled_leave_approved' ? html`
            <button class="btn ghost" onClick=${() => {
              const prev = closedRows.find(r => r.employee_code === e.employee_code) || {};
              setAsk({ code: e.employee_code, name: nameOf(e.employee_code), decision: 'manual',
                reason: 'Re-suspended after an approval made in error',
                dates: (Array.isArray(prev.absent_dates) ? prev.absent_dates : []).join(', '),
                refNote: `manual re-suspension, ref: case of ${prev.suspended_on || (e.at ? new Date(e.at).toLocaleDateString('en-PH') : '—')} — letter already on file`,
                letterOnFile: true });
              setPin(''); setErr('');
            }}>Re-suspend (letter on file)</button>` : ''}
```

- [ ] **Step 5: Add the manual-suspension form**

At the bottom of the main card, after the "Recently closed" list:

```js
      <div class="sectlabel">Suspend someone manually</div>
      ${manual == null
        ? html`<button class="btn ghost" onClick=${() => setManual({ code: '', reason: '', dates: '' })}>Suspend someone manually</button>`
        : html`
          <div style="display:grid;gap:8px">
            <select data-manual-emp value=${manual.code} onChange=${e => setManual(m => ({ ...m, code: e.target.value }))}>
              <option value="">— choose a worker —</option>
              ${(emps || []).filter(e => !/^PEM/i.test(String(e.code).replace(/\s/g, '').toUpperCase()))
                .map(e => html`<option value=${e.code} key=${e.code}>${e.name} (${e.code})</option>`)}
            </select>
            <input data-manual-reason placeholder="Reason" value=${manual.reason} onInput=${e => setManual(m => ({ ...m, reason: e.target.value }))} />
            <input data-manual-dates placeholder="Absent dates, comma separated (e.g. 2026-07-22, 2026-07-23)" value=${manual.dates} onInput=${e => setManual(m => ({ ...m, dates: e.target.value }))} />
            <p class="note" style="margin:0">At least one date is required — the printable letter is built from these.</p>
            <span style="display:flex;gap:8px">
              <button class="btn" onClick=${() => {
                if (!manual.code) { flash('Choose a worker'); return; }
                setAsk({ code: manual.code, name: nameOf(manual.code), decision: 'manual',
                  reason: manual.reason, dates: manual.dates, refNote: null, letterOnFile: false });
                setPin(''); setErr('');
              }}>Create suspension</button>
              <button class="btn ghost" onClick=${() => setManual(null)}>Cancel</button>
            </span>
          </div>`}
```

- [ ] **Step 6: Run the smoke test**

```bash
node tests/awol-dashboard/dashboard-awol.smoke.mjs
```

Expected: all checks PASS, including the PEM-not-listed and dates-required checks.

- [ ] **Step 7: Validate + commit**

```bash
node --check home.js && echo "home.js OK"
git add home.js tests/awol-dashboard/dashboard-awol.smoke.mjs
git commit -m "feat(dashboard): manual suspension + re-suspension carrying an on-file letter forward"
```

---

## Task 7: Harness — mock the new RPCs and cover the gate cross-device

**Files:**
- Modify: `tests/kiosk-stress/kiosk-stress.mjs`

**Interfaces:**
- Consumes: every RPC from Task 1.
- Produces: `mock.suspensions[code].letter_received` available to all scenarios.

- [ ] **Step 1: Extend the mocked RPC layer**

After the existing `awol_reinstate` mock (~line 192):

```js
      if (p.endsWith('/rest/v1/rpc/awol_letter_received')) {
        let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch {}
        const r = mock.suspensions[b.p_code];
        if (!r || !r.active || r.letter_received) return json(200, { newly: false });
        r.letter_received = true; r.letter_received_by = b.p_by;
        return json(200, { newly: true });
      }
      if (p.endsWith('/rest/v1/rpc/awol_admin_decide')) {
        let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch {}
        const r = mock.suspensions[b.p_code];
        if (!r || !r.active) return json(200, { newly: false, reason: 'not currently suspended' });
        if (b.p_decision === 'approve') {
          if (!r.letter_received) return json(200, { newly: false, reason: 'letter not yet confirmed' });
          r.active = false; r.last_decision = 'approved'; r.reinstated_by = b.p_by;
          return json(200, { newly: true, awol_group_msg_id: r.awol_group_msg_id, awol_group_chat: r.awol_group_chat });
        }
        r.letter_received = false; r.letter_received_by = null; r.last_decision = 'kept';
        return json(200, { newly: true, kept: true });
      }
      if (p.endsWith('/rest/v1/rpc/awol_manual_suspend')) {
        let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch {}
        if (/^PEM/i.test(String(b.p_code || '').replace(/\s/g, '')))
          return json(200, { newly: false, reason: 'PAKYAW/PEM workers are exempt from AWOL' });
        if (!Array.isArray(b.p_dates) || !b.p_dates.length)
          return json(200, { newly: false, reason: 'at least one absent date is required' });
        const ex = mock.suspensions[b.p_code];
        if (ex && ex.active) return json(200, { newly: false, reason: 'already suspended' });
        mock.suspensions[b.p_code] = { employee_code: b.p_code, active: true, reason: b.p_reason,
          suspended_on: '', absent_dates: b.p_dates, awol_group_msg_id: null, awol_group_chat: null,
          letter_received: !!b.p_letter_on_file, manual: true, ref_note: b.p_ref_note || null };
        return json(200, { newly: true });
      }
```

Also make the PEM guard real in the `awol_set_suspended` mock — add as its first line after parsing `b`:

```js
        if (/^PEM/i.test(String(b.p_code || '').replace(/\s/g, ''))) return json(200, false);
```

- [ ] **Step 2: Add the cross-device gate scenario**

```js
// G11 — THE GATE, CROSS-DEVICE: an approval on the dashboard must lift the block on the kiosks
// via the existing poller, and an approve attempted without the letter tick must be refused.
await scenario('G11 · two-step gate lifts the block on every kiosk', manila(2026, 7, 21, 8, 0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1004443332221';
  await page.evaluate(() => loadTgFromCloud());
  mock.suspensions['RSR0100'] = { employee_code: 'RSR0100', active: true, reason: 'AWOL',
    suspended_on: '07/20/2026', absent_dates: ['2026-07-17','2026-07-18','2026-07-20'],
    awol_group_msg_id: '9100', awol_group_chat: '-1004443332221', letter_received: false };
  await page.evaluate(() => loadSuspensionsFromCloud());
  const blockedBefore = await page.evaluate(() => !!suspendedEmployees['RSR0100']);

  // The dashboard's approve RPC, called without the letter tick, must be refused.
  const refused = await page.evaluate(async () => {
    const { data } = await sbClient.rpc('awol_admin_decide', { p_code: 'RSR0100', p_by: 'Boss', p_decision: 'approve' });
    return data;
  });
  report('G11a · approve refused before the letter is confirmed',
    refused && refused.newly === false && /letter/i.test(refused.reason || ''),
    `response=${JSON.stringify(refused)}`);
  const stillBlocked = await page.evaluate(() => !!suspendedEmployees['RSR0100']);
  report('G11b · worker still blocked after the refused approval', blockedBefore && stillBlocked);

  // Tick, then approve — the kiosk's own poller must clear the block with no kiosk-side action.
  await page.evaluate(async () => { await sbClient.rpc('awol_letter_received', { p_code: 'RSR0100', p_by: 'Jamaica L. Batucan' }); });
  await page.evaluate(async () => { await sbClient.rpc('awol_admin_decide', { p_code: 'RSR0100', p_by: 'Boss', p_decision: 'approve' }); });
  await page.evaluate(() => loadSuspensionsFromCloud());
  const clearedAfter = await page.evaluate(() => !!suspendedEmployees['RSR0100']);
  report('G11c · after approval the poller clears the block on this kiosk',
    !clearedAfter && mock.suspensions['RSR0100'].active === false,
    `blockedLocally=${clearedAfter} activeInDb=${mock.suspensions['RSR0100'].active}`);

  // Keep-suspended resets the tick and leaves the block in place.
  mock.suspensions['RSR0207'] = { employee_code: 'RSR0207', active: true, reason: 'AWOL',
    suspended_on: '07/20/2026', absent_dates: ['2026-07-17','2026-07-18','2026-07-20'],
    awol_group_msg_id: '9101', awol_group_chat: '-1004443332221', letter_received: true };
  await page.evaluate(async () => { await sbClient.rpc('awol_admin_decide', { p_code: 'RSR0207', p_by: 'Boss', p_decision: 'keep' }); });
  await page.evaluate(() => loadSuspensionsFromCloud());
  const stillBlocked207 = await page.evaluate(() => !!suspendedEmployees['RSR0207']);
  report('G11d · keep-suspended clears the tick and the worker stays blocked',
    mock.suspensions['RSR0207'].active === true && mock.suspensions['RSR0207'].letter_received === false && stillBlocked207,
    `activeInDb=${mock.suspensions['RSR0207'].active} letter=${mock.suspensions['RSR0207'].letter_received} blocked=${stillBlocked207}`);
});
```

- [ ] **Step 3: Run the full harness**

```bash
node tests/kiosk-stress/kiosk-stress.mjs
```

Expected: `G11a`–`G11d` PASS and every earlier scenario still passes.

- [ ] **Step 4: Commit**

```bash
git add tests/kiosk-stress/kiosk-stress.mjs
git commit -m "test(kiosk): mock the gate RPCs; cross-device two-step gate scenarios"
```

---

## Task 8: Real-data gate check, preflight, and walkthrough prep

**Files:**
- Create: `tests/kiosk-stress/awol-realdata-check.mjs`
- Modify: `preflight.html:38-44`

**Interfaces:**
- Consumes: the real `collectAbsentDates` / `checkAllAbsences` / `isPemCode` from `kiosk/index.html`.

- [ ] **Step 1: Write the real-data check**

This is the owner's explicit gate item. It reuses the REAL kiosk functions (never a reimplementation), feeds them REAL attendance read from Supabase, and mocks every write so nothing can be created.

Create `tests/kiosk-stress/awol-realdata-check.mjs`:

```js
// OWNER GATE ITEM (2026-07-26): point AWOL detection at the REAL 2026-07-19 → 2026-07-25
// attendance and prove it now suspends nobody. Those 42 walkthrough rows came from exactly that
// week pre-fix; if anything in it still trips detection it must surface here, not at 6am with 40
// workers blocked at the kiosk.
//
// Reads live attendance READ-ONLY. Every write path (RPC, PATCH, Telegram) is mocked and asserted
// to have received nothing. Run: node tests/kiosk-stress/awol-realdata-check.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const HOST = 'wpmcbjrisuyjvobvzaus.supabase.co';
const KEY = process.env.RSR_ANON_KEY;
if (!KEY) { console.error('Set RSR_ANON_KEY and re-run.'); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// ── pull the real data (read-only) ────────────────────────────────────────────
// attendance_records.date is TEXT in MIXED formats, so fetch broadly and filter client-side.
const att = await (await fetch(`https://${HOST}/rest/v1/attendance_records?select=*&limit=20000`, { headers: H })).json();
const emps = await (await fetch(`https://${HOST}/rest/v1/employees?select=code,name,pin,home_site,daily_rate,shift`, { headers: H })).json();
let leaves = [];
try { leaves = await (await fetch(`https://${HOST}/rest/v1/leave_requests?select=*&limit=5000`, { headers: H })).json(); } catch (_) { leaves = []; }
console.log(`fetched: ${att.length} attendance rows · ${emps.length} employees · ${(leaves || []).length} leave requests`);

const toISO = (s) => {
  s = String(s || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : s;
};
const inWindow = att.filter(r => { const d = toISO(r.date); return d >= '2026-07-19' && d <= '2026-07-25'; });
console.log(`rows inside 2026-07-19 → 2026-07-25: ${inWindow.length}`);

// ── serve the repo + run the kiosk with all writes walled off ─────────────────
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const idx = path.join(file, 'index.html');
    if (fs.existsSync(idx)) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(idx)); }
    res.writeHead(404); return res.end('');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}).listen(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const writes = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.addInitScript(() => {
  const FIXED = new Date('2026-07-26T08:00:00+08:00').getTime();
  const R = Date; window.Date = class extends R {
    constructor(...a) { return a.length ? new R(...a) : new R(FIXED); }
    static now() { return FIXED; }
  };
});
await context.route('**/*', (route) => {
  const url = route.request().url(), method = route.request().method();
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (url.includes(HOST)) {
    if (method !== 'GET') { writes.push(`${method} ${url} ${route.request().postData() || ''}`); return json({}); }
    if (url.includes('/employee_suspensions')) return json([]);         // start from a clean slate
    if (url.includes('/attendance_records')) return json(att);
    if (url.includes('/employees')) return json(emps);
    if (url.includes('/leave_requests')) return json(leaves || []);
    return json([]);
  }
  if (url.includes('api.telegram.org')) { writes.push(`TELEGRAM ${url}`); return json({ ok: true, result: { message_id: 1 } }); }
  if (url.startsWith(base)) return route.continue();
  return json([]);
});

const page = await context.newPage();
await page.goto(`${base}/kiosk/`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => typeof checkAllAbsences === 'function' && Array.isArray(employees) && employees.length > 0);

// DELIBERATELY does NOT call checkAllAbsences(). On 2026-07-26 an unscoped checkAllAbsences() run
// against the live roster suspended 42 real workers and fired ~20 group alerts. collectAbsentDates()
// is a PURE READ over `records` — it computes the identical absence chain that checkAllAbsences would
// act on, with no code path that can write, alert, or suspend. The route interception below is the
// second layer; not calling the mutating function at all is the first.
const perWorker = await page.evaluate(() => employees.map(e => ({
  code: e.code, name: e.name, pem: isPemCode(e.code), chain: collectAbsentDates(e.code),
})));

const wouldSuspend = perWorker.filter(w => !w.pem && w.chain.length >= 3);
console.log(`\nPEM workers skipped: ${perWorker.filter(w => w.pem).map(w => w.code).join(', ') || '(none)'}`);
if (wouldSuspend.length) {
  console.log(`\n\x1b[31mWORKERS THAT WOULD BE SUSPENDED:\x1b[0m`);
  wouldSuspend.forEach(w => console.log(`  ${w.code} ${w.name} — ${w.chain.length} absences: ${w.chain.join(', ')}`));
}

const ok = wouldSuspend.length === 0 && writes.length === 0;
console.log(`\n${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  real-data detection over 2026-07-19 → 2026-07-25`);
console.log(`      wouldSuspend=${wouldSuspend.length} writesAttempted=${writes.length} (must both be 0)`);
if (writes.length) writes.forEach(w => console.log(`      \x1b[33mWRITE ATTEMPT: ${w}\x1b[0m`));

await browser.close(); server.close();
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: Run it — this is the gate**

```bash
RSR_ANON_KEY="$(grep -o "eyJ[A-Za-z0-9._-]*" supabase.js | head -1)" node tests/kiosk-stress/awol-realdata-check.mjs
```

Expected: `PASS  real-data detection over 2026-07-19 → 2026-07-25`, with `suspended=0 wouldSuspend=0 writesAttempted=0`.

**If it FAILs, stop.** The script prints every worker it would suspend and their absence chain. Investigate before anything ships — the owner's instruction is explicit that nothing goes live until this reads zero.

- [ ] **Step 3: Confirm preflight**

`preflight.html:38-44` — confirm `'kiosk/index.html':'v2026-07-26a'` from Task 3 is in place. Leave `awol-letter.html` at its current stamp; this build does not modify it.

- [ ] **Step 4: Full verification sweep**

```bash
node tests/kiosk-stress/kiosk-stress.mjs
node tests/awol-dashboard/dashboard-awol.smoke.mjs
RSR_ANON_KEY="$(grep -o "eyJ[A-Za-z0-9._-]*" supabase.js | head -1)" node tests/awol-reinstate-flow/verify-sql.mjs
RSR_ANON_KEY="$(grep -o "eyJ[A-Za-z0-9._-]*" supabase.js | head -1)" node tests/kiosk-stress/awol-realdata-check.mjs
node --check home.js && node --check coordinator.js
node -e "const fs=require('fs');const s=fs.readFileSync('kiosk/index.html','utf8');const m=[...s.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(x=>x[1]).sort((a,b)=>b.length-a.length)[0];fs.writeFileSync(process.env.TMP+'/kiosk-check.mjs',m);" && node --check "$TMP/kiosk-check.mjs"
grep -c "$OLD_REF" kiosk/index.html home.js coordinator.js preflight.html awol-reinstate-flow.sql
```

Expected: every harness green, every `node --check` silent, every `$OLD_REF` count `0`.

- [ ] **Step 5: Commit**

```bash
git add tests/kiosk-stress/awol-realdata-check.mjs preflight.html
git commit -m "test(awol): real-data detection gate over 2026-07-19 → 2026-07-25; preflight stamps"
```

- [ ] **Step 6: Owner walkthrough — STOP HERE, do not push**

Serve locally and walk the owner through, in this order (from the spec):

1. **Real-data check reads zero** — show the Step 2 output. Nothing proceeds otherwise.
2. PEM worker with a long absence → no suspension, no alert, nothing in the group.
3. Suspend a test worker → alert + letter render → Jamaica's PIN ticks the letter (Alvin's PIN refused with the neutral message) → dashboard shows "Needs your decision" → **Keep suspended** → tick cleared, still blocked → tick again → **Approve** → block lifts on both kiosks, group shows REINSTATED, original edited to RESOLVED.
4. Approve by mistake → **Re-suspend (letter on file)** → back in "Needs your decision" with the ref note.
5. Admin fallback tick with the admin PIN → recorded as `Admin — <name>`.
6. Leave-approval path → **CANCELLED — leave approved**, not a reinstatement.
7. Kiosk Staff list shows the badge and no reinstate button; Telegram reinstate buttons gone.

Then wait for the owner's explicit **"push"**. After push: verify the live version stamp with a cache-busted fetch, and tell the owner the exact commit + files that went live. Tablets need `reset.html`.

---

## Self-Review

**Spec coverage** — every section maps to a task: gate schema + audit log + RPCs → Task 1; PEM exemption + G8c repair → Task 2; kiosk-only-door + modal text + leave relabel → Task 3; coordinator step 1 + clerk PIN → Task 4; dashboard step 2 + admin fallback tick + PIN-every-approval → Task 5; manual (re-)suspension → Task 6; the ten harness scenarios → Tasks 2, 3, 7; cleanup SQL → Task 1; real-data gate + walkthrough + stamps → Task 8. The spec's "no Undo" is covered negatively by an explicit smoke assertion in Task 4.

**Naming consistency** — `isPemCode` (kiosk, Task 2) is used in Tasks 2/3/8; `awol_is_pem` is its server mirror; `notifyAwol` exists separately in `coordinator.js` (Task 4) and `home.js` (Task 5) because the two files share no module; `awol_admin_decide` takes `p_decision` `'approve'|'keep'` everywhere; `letter_received` is spelled identically in the SQL, both mocks, and both UIs; `sendAwolReinstatedMsg` is renamed to `sendAwolCancelledMsg` in Task 3 and referenced nowhere else.

**Known soft spots, flagged rather than hidden:** the Playwright selectors in Tasks 4–6 (`button:has-text(...)`, `data-awol-pin`, `data-manual-emp`, `data-admin-key`) depend on the exact markup written in the same task — an implementer who renames a label must update the selector in the same commit. `home.js` may already define a `getSetting`; Task 5 says to reuse it rather than add a second one. And the `mock.tgCallbacks`/`getUpdates` hook in Task 3 must be added to the harness if it does not already exist, plus reset in `scenario()`.
