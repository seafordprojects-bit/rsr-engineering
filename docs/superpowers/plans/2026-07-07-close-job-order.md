# Close Job Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit two-stage "Close job order" (coordinator operational close → owner incentive approval) with a required actual-installed-quantity encoding, frozen and auditable.

**Architecture:** Mirror the existing Close-week append-only pattern — new `job_close` snapshot + `job_close_audit` log (+ `settings_audit`), immutability triggers, status derived from the latest audit action. Pure settlement/discrepancy logic lives in a testable `monitoring/jobclose.mjs`; DB orchestration in `monitoring/config.js`; UI in `monitoring/efficiency.html` (By-job view). Actual-installed supersedes the last roll-call reading via a final `job_progress` row (never touches `jobs.quantity`). Freeze via `jobs.status='closed'` + a DB backstop trigger.

**Tech Stack:** Vanilla JS + Preact/htm via CDN (no build), Supabase `wpmcbjrisuyjvobvzaus` (RLS off, PostgREST), Node for validation/tests.

**Source spec:** `docs/superpowers/specs/2026-07-07-close-job-order-design.md`

## Global Constraints

- No build step; Vanilla JS + Preact/htm via CDN importmap. No npm/bundler/framework.
- Supabase project **`wpmcbjrisuyjvobvzaus` ONLY**; never `azfmpleswqixaslvcito`.
- htm/JS template literals use **literal `&`** (never `&amp;`); SQL uses `--` comments (never `//`).
- Before shipping any HTML: extract the largest inline `<script>` and run `node --check` on it as ESM; hygiene grep (`wpmcbjrisuyjvobvzaus` present in `config.js`, `azfmpleswqixaslvcito` absent).
- **Read the CURRENT live file before editing** (past incidents wiped sections from stale copies).
- **Never write `jobs.quantity` / `jobs.rate_used` / `jobs.correction_factor` in the close flow** — the `jobs_reset_calibration` trigger would silently un-calibrate the job.
- `settings` is a key/value table (`{id, key, value}`), read via `getSetting(key)`. **`owner_pin` has NO default** — absent until the owner sets it; checked **server-side only** (no client default, no localStorage). Set/change is audited.
- Append-only: `job_close`, `job_close_audit`, `settings_audit` are immutable via the existing `block_mutation()`.
- `job_checkpoint.employee_code` holds `employees.id` as **text**; `job_progress.work_date` is a real `date`; `efficiency_week` is immutable (frozen weeks won't recompute).
- **Deploy rule:** interactive pages (`efficiency.html`, `roll-call.html`, `assign.html`, `home.js`) **pause for the owner's localhost walkthrough before pushing to `main`.** SQL is handed to the owner to run in Supabase. Never auto-commit pay-affecting changes without approval.
- E2E must use a **TEST-prefixed job**, never a live/frozen one. Delete test rows after.

---

### Task 1: Pure settlement/discrepancy logic + golden tests

**Files:**
- Create: `monitoring/jobclose.mjs`
- Test: `monitoring/jobclose.test.mjs`

**Interfaces:**
- Produces: `creditedUnits(actualInstalled, target) -> number|null`; `isOverrun(actualInstalled, target) -> boolean`; `computeDiscrepancy(actualInstalled, lastCumulative, unit) -> {delta:number, pct:number|null, text:string}`; `closeStatusFromAudit(latestAction) -> 'pending'|'approved'|'open'`.

- [ ] **Step 1: Write the failing tests** — `monitoring/jobclose.test.mjs`:

```js
import assert from 'node:assert/strict';
import { creditedUnits, isOverrun, computeDiscrepancy, closeStatusFromAudit } from './jobclose.mjs';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('creditedUnits caps at target', () => { assert.equal(creditedUnits(420, 400), 400); assert.equal(creditedUnits(380, 400), 380); });
t('creditedUnits null target -> null', () => { assert.equal(creditedUnits(400, null), null); });
t('isOverrun', () => { assert.equal(isOverrun(420, 400), true); assert.equal(isOverrun(400, 400), false); assert.equal(isOverrun(400, null), false); });
t('discrepancy exact match', () => { const d = computeDiscrepancy(400, 400, 'kg'); assert.equal(d.delta, 0); assert.equal(d.text, 'matches last report'); });
t('discrepancy under', () => { const d = computeDiscrepancy(388, 400, 'kg'); assert.equal(d.delta, -12); assert.equal(d.pct, -3); assert.equal(d.text, '−12 kg vs last roll-call report (−3%)'); });
t('discrepancy over', () => { const d = computeDiscrepancy(410, 400, 'kg'); assert.equal(d.delta, 10); assert.equal(d.pct, 2.5); assert.equal(d.text, '+10 kg vs last roll-call report (+2.5%)'); });
t('discrepancy no prior (base 0) -> pct null', () => { const d = computeDiscrepancy(400, null, 'kg'); assert.equal(d.pct, null); assert.equal(d.text, '+400 kg vs last roll-call report'); });
t('closeStatusFromAudit', () => { assert.equal(closeStatusFromAudit('operational_close'), 'pending'); assert.equal(closeStatusFromAudit('incentive_approve'), 'approved'); assert.equal(closeStatusFromAudit('reopen'), 'open'); assert.equal(closeStatusFromAudit(null), 'open'); });

console.log(`\n${n} tests passed`);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node monitoring/jobclose.test.mjs`
Expected: FAIL — `Cannot find module './jobclose.mjs'`.

- [ ] **Step 3: Implement** — `monitoring/jobclose.mjs`:

```js
// Pure helpers for Close-job-order. No DB, no DOM — unit-testable.

// Credited units are capped at target; a null target is never payable (null).
export function creditedUnits(actualInstalled, target) {
  if (target == null) return null;
  return Math.min(Number(actualInstalled), Number(target));
}

// Installing beyond target is an overrun (earns nothing on the overage).
export function isOverrun(actualInstalled, target) {
  return target != null && Number(actualInstalled) > Number(target);
}

// Discrepancy of actual-installed vs the last roll-call cumulative.
// base = last cumulative (0 when none). Uses a real minus sign (U+2212) for display.
export function computeDiscrepancy(actualInstalled, lastCumulative, unit) {
  const base = (lastCumulative == null ? 0 : Number(lastCumulative));
  const delta = Math.round((Number(actualInstalled) - base) * 1000) / 1000;
  const pct = base > 0 ? Math.round((delta / base) * 1000) / 10 : null;
  if (delta === 0) return { delta: 0, pct, text: 'matches last report' };
  const u = unit || 'units';
  const sign = delta > 0 ? '+' : '−';
  let text = `${sign}${Math.abs(delta)} ${u} vs last roll-call report`;
  if (pct != null) text += ` (${delta > 0 ? '+' : '−'}${Math.abs(pct)}%)`;
  return { delta, pct, text };
}

// Current close status from the latest audit action for a job.
export function closeStatusFromAudit(latestAction) {
  if (latestAction === 'operational_close') return 'pending';
  if (latestAction === 'incentive_approve') return 'approved';
  return 'open'; // 'reopen' or none
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node monitoring/jobclose.test.mjs`
Expected: PASS — `8 tests passed`.

- [ ] **Step 5: Commit**

```bash
git add monitoring/jobclose.mjs monitoring/jobclose.test.mjs
git commit -m "feat(kpi): pure close-job settlement/discrepancy helpers + tests"
```

---

### Task 2: SQL — append-only close tables, triggers, view, backstop

**Files:**
- Modify: `monitoring/sql/personnel-kpi.sql` (append a new section at end of file)
- Test: `scratchpad/verify-jobclose-sql.mjs` (NOT committed — hits live DB)

**Interfaces:**
- Produces (DB): tables `job_close`, `job_close_audit`, `settings_audit`; view `v_job_close_status(job_id, action, version, actor, at)`; trigger `block_closed_job_write()` on `job_progress`/`job_checkpoint`; append-only triggers reusing `block_mutation()`.

- [ ] **Step 1: Append the SQL** to `monitoring/sql/personnel-kpi.sql` (verbatim; `--` comments only):

```sql
-- ============================================================ CLOSE JOB ORDER
-- Two-stage close (coordinator operational close -> owner incentive approval),
-- append-only, mirroring the efficiency_week pattern. See
-- docs/superpowers/specs/2026-07-07-close-job-order-design.md
create table if not exists job_close (
  id                  uuid primary key default gen_random_uuid(),
  job_id              uuid not null references jobs(id),
  close_version       integer not null default 1,
  actual_installed    numeric not null,        -- coordinator's final measured quantity (job unit)
  last_rollcall_units numeric,                 -- latest job_progress cumulative BEFORE this close
  target_quantity     numeric,                 -- jobs.quantity at close (null = no target)
  credited_units      numeric,                 -- least(actual_installed, target); null if no target
  earned_hours        numeric,                 -- frozen from v_job_efficiency at close
  actual_hours        numeric,
  efficiency          numeric,
  overrun             boolean not null default false,
  discrepancy_delta   numeric,
  discrepancy_pct     numeric,
  calibrated_at_close boolean not null default false,
  closed_by           text,
  closed_at           timestamptz not null default now(),
  unique (job_id, close_version)
);

create table if not exists job_close_audit (
  id      uuid primary key default gen_random_uuid(),
  job_id  uuid not null references jobs(id),
  action  text not null,        -- 'operational_close' | 'incentive_approve' | 'reopen'
  version integer not null,
  actor   text,
  note    text,
  at      timestamptz not null default now()
);

-- Security-config audit: logs owner-PIN set/change. NEVER stores the PIN value.
create table if not exists settings_audit (
  id     uuid primary key default gen_random_uuid(),
  key    text not null,         -- e.g. 'owner_pin'
  action text not null,         -- 'set' | 'change'
  actor  text,
  at     timestamptz not null default now()
);

-- Append-only immutability (reuse the existing block_mutation() from this file).
drop trigger if exists trg_jobclose_immutable on job_close;
create trigger trg_jobclose_immutable before update or delete on job_close
  for each row execute function block_mutation();
drop trigger if exists trg_jobcloseaudit_immutable on job_close_audit;
create trigger trg_jobcloseaudit_immutable before update or delete on job_close_audit
  for each row execute function block_mutation();
drop trigger if exists trg_settingsaudit_immutable on settings_audit;
create trigger trg_settingsaudit_immutable before update or delete on settings_audit
  for each row execute function block_mutation();

-- Current close status per job = latest audit action (mirrors efficiency isClosed()).
create or replace view v_job_close_status as
select distinct on (job_id) job_id, action, version, actor, at
from job_close_audit order by job_id, at desc;

-- Backstop: once a job is closed, freeze it — reject progress/checkpoint writes.
-- The close flow writes the final job_progress row BEFORE flipping status='closed',
-- so only post-close writes are blocked. Reopen sets status back to 'ongoing'.
create or replace function block_closed_job_write() returns trigger as $$
begin
  if exists (select 1 from jobs j where j.id = new.job_id and j.status = 'closed') then
    raise exception 'job % is closed; progress/checkpoint writes are frozen', new.job_id;
  end if;
  return new;
end;
$$ language plpgsql;
drop trigger if exists trg_jp_block_closed on job_progress;
create trigger trg_jp_block_closed before insert or update on job_progress
  for each row execute function block_closed_job_write();
drop trigger if exists trg_jc_block_closed on job_checkpoint;
create trigger trg_jc_block_closed before insert or update on job_checkpoint
  for each row execute function block_closed_job_write();
```

- [ ] **Step 2: Hand the SQL to the owner to run** in the Supabase SQL editor (project `wpmcbjrisuyjvobvzaus`). Expected: "Success. No rows returned."

- [ ] **Step 3: Write + run the verification script** `scratchpad/verify-jobclose-sql.mjs` (uses BASE + anon key from `monitoring/config.js`). It asserts, after the owner has run the SQL:
  - `GET /job_close?limit=1`, `/job_close_audit?limit=1`, `/settings_audit?limit=1`, `/v_job_close_status?limit=1` all return HTTP 200 (objects exist).
  - Append-only proof: `PATCH /job_close_audit?id=eq.<any>` (or an insert-then-update) returns an error containing `append-only`.
  - Backstop proof: on a scratch TEST job set to `status='closed'`, `POST /job_progress` is rejected with `is closed`.

Run: `node scratchpad/verify-jobclose-sql.mjs`
Expected: prints `ALL SQL CHECKS PASS`. (Clean up any TEST rows created.)

- [ ] **Step 4: Commit** (SQL file only — verify script stays in scratchpad):

```bash
git add monitoring/sql/personnel-kpi.sql
git commit -m "feat(kpi): close-job SQL — append-only job_close/audit, status view, freeze backstop"
```

---

### Task 3: config.js — close/approve/reopen/status + PIN helpers

**Files:**
- Modify: `monitoring/config.js` (add exports; read current file first — it exports `sb`, `upsertJobProgress`, `fmtNum`, `todayLocal`, `weekContaining`, etc.)
- Test: `scratchpad/verify-jobclose-flow.mjs` (NOT committed — integration against a TEST job)

**Interfaces:**
- Consumes: `monitoring/jobclose.mjs` (Task 1); existing `sb`, `upsertJobProgress`, `todayLocal`, `weekContaining` from `config.js`.
- Produces: `getSetting(key)`, `setSetting(key,value)`, `setOwnerPin(newPin, actor)`, `checkOwnerPin(pin) -> {ok, notSet}`, `checkCoordPin(pin) -> {ok}`, `loadJobCloseStatus(jobId) -> {status, version, action}`, `loadAllJobCloseStatus() -> {jobId: {status,version,action}}`, `closedWeekWarning(jobId, actualInstalled, lastCum) -> string[]`, `closeJobOrder(job, {actualInstalled, coordinator, coordPin, note}) -> {version, disc, credited, over}`, `approveJob(job, {ownerPin, owner}) -> {version}`, `reopenJob(job, {ownerPin, owner, reason})`.

- [ ] **Step 1: Add the import** at the top of `monitoring/config.js` (next to existing imports):

```js
import { computeDiscrepancy, creditedUnits, isOverrun, closeStatusFromAudit } from "./jobclose.mjs";
```

- [ ] **Step 2: Append the helpers** to `monitoring/config.js`:

```js
// ---- settings / PIN (settings is a {id,key,value} table; owner_pin has NO default) ----
export async function getSetting(key){
  const { data } = await sb.from("settings").select("value").eq("key", key).maybeSingle();
  return data ? data.value : null;
}
export async function setSetting(key, value){
  const { data } = await sb.from("settings").select("id").eq("key", key).maybeSingle();
  if (data){ const { error } = await sb.from("settings").update({ value }).eq("key", key); if (error) throw error; }
  else { const { error } = await sb.from("settings").insert({ key, value }); if (error) throw error; }
}
export async function setOwnerPin(newPin, actor){
  const existed = (await getSetting("owner_pin")) != null;
  await setSetting("owner_pin", String(newPin));
  const { error } = await sb.from("settings_audit").insert({ key:"owner_pin", action: existed?"change":"set", actor: actor||null });
  if (error) throw error;
}
export async function checkOwnerPin(pin){
  const v = await getSetting("owner_pin");
  if (v == null) return { ok:false, notSet:true };
  return { ok: String(pin) === String(v), notSet:false };
}
export async function checkCoordPin(pin){
  const v = await getSetting("coordinator_pin");
  return { ok: v != null && String(pin) === String(v) };
}

// ---- close status ----
export async function loadJobCloseStatus(jobId){
  const { data } = await sb.from("v_job_close_status").select("action,version").eq("job_id", jobId).maybeSingle();
  const action = data ? data.action : null;
  return { status: closeStatusFromAudit(action), version: data ? data.version : 0, action };
}
export async function loadAllJobCloseStatus(){
  const { data } = await sb.from("v_job_close_status").select("job_id,action,version");
  const m = {}; (data||[]).forEach(r => { m[r.job_id] = { status: closeStatusFromAudit(r.action), version:r.version, action:r.action }; });
  return m;
}

// ---- closed-week warning: weeks this job's checkpoints span that are already closed ----
export async function closedWeekWarning(jobId, actualInstalled, lastCum){
  if (Number(actualInstalled) === Number(lastCum||0)) return [];   // no earned change -> no warning
  const { data:cps } = await sb.from("job_checkpoint").select("work_date").eq("job_id", jobId);
  const weeks = [...new Set((cps||[]).map(r => weekContaining(r.work_date)))];
  const closed = [];
  for (const wk of weeks){
    const { data } = await sb.from("efficiency_week_audit").select("action").eq("week_start", wk).order("at",{ascending:false}).limit(1);
    if (data && data[0] && data[0].action === "close") closed.push(wk);
  }
  return closed;
}

// ---- Stage 1: operational close (coordinator) ----
export async function closeJobOrder(job, { actualInstalled, coordinator, coordPin, note }){
  const pc = await checkCoordPin(coordPin);
  if (!pc.ok) throw new Error("Wrong coordinator passcode.");
  const st = await loadJobCloseStatus(job.job_id);
  if (st.status !== "open") throw new Error("Job is already closed.");
  const { data:lastRows } = await sb.from("job_progress").select("units_cumulative,work_date")
    .eq("job_id", job.job_id).order("work_date",{ascending:false}).limit(1);
  const lastCum = (lastRows && lastRows[0]) ? Number(lastRows[0].units_cumulative) : null;
  // Supersede the last cumulative with the final installed quantity (final job_progress row, today).
  await upsertJobProgress(job.job_id, todayLocal(), Number(actualInstalled), coordinator || null);
  // Read the recomputed settlement to freeze it.
  const { data:eff } = await sb.from("v_job_efficiency").select("*").eq("job_id", job.job_id).maybeSingle();
  const disc = computeDiscrepancy(Number(actualInstalled), lastCum, job.unit);
  const target = job.quantity;   // jobs.quantity (target) — do NOT write it
  const credited = creditedUnits(Number(actualInstalled), target);
  const over = isOverrun(Number(actualInstalled), target);
  const { data:mv } = await sb.from("job_close").select("close_version").eq("job_id", job.job_id).order("close_version",{ascending:false}).limit(1);
  const version = ((mv && mv[0] && mv[0].close_version) || 0) + 1;
  const ins = await sb.from("job_close").insert({
    job_id: job.job_id, close_version: version, actual_installed: Number(actualInstalled),
    last_rollcall_units: lastCum, target_quantity: target, credited_units: credited,
    earned_hours: eff ? eff.earned_hours : null, actual_hours: eff ? eff.actual_hours : null,
    efficiency: eff ? eff.efficiency : null, overrun: over,
    discrepancy_delta: disc.delta, discrepancy_pct: disc.pct,
    calibrated_at_close: !!job.calibrated, closed_by: coordinator || null,
  });
  if (ins.error) throw new Error(ins.error.message);
  const aud = await sb.from("job_close_audit").insert({
    job_id: job.job_id, action: "operational_close", version, actor: coordinator || null, note: note || disc.text });
  if (aud.error) throw new Error(aud.error.message);
  const upd = await sb.from("jobs").update({ status: "closed" }).eq("id", job.job_id);   // freeze (status only)
  if (upd.error) throw new Error(upd.error.message);
  return { version, disc, credited, over };
}

// ---- Stage 2: incentive approval (owner) ----
export async function approveJob(job, { ownerPin, owner }){
  const st = await loadJobCloseStatus(job.job_id);
  if (st.status !== "pending") throw new Error("Job is not pending approval.");
  if (!job.calibrated) throw new Error("Calibrate the job before approving.");
  const chk = await checkOwnerPin(ownerPin);
  if (chk.notSet) throw new Error("OWNER_PIN_NOT_SET");
  if (!chk.ok) throw new Error("Wrong owner passcode.");
  const aud = await sb.from("job_close_audit").insert({ job_id: job.job_id, action:"incentive_approve", version: st.version, actor: owner || null, note: null });
  if (aud.error) throw new Error(aud.error.message);
  return { version: st.version };
}

// ---- Reopen (owner, any stage) ----
export async function reopenJob(job, { ownerPin, owner, reason }){
  const st = await loadJobCloseStatus(job.job_id);
  if (st.status === "open") throw new Error("Job is not closed.");
  const chk = await checkOwnerPin(ownerPin);
  if (chk.notSet) throw new Error("OWNER_PIN_NOT_SET");
  if (!chk.ok) throw new Error("Wrong owner passcode.");
  const aud = await sb.from("job_close_audit").insert({ job_id: job.job_id, action:"reopen", version: st.version, actor: owner || null, note: reason || null });
  if (aud.error) throw new Error(aud.error.message);
  const upd = await sb.from("jobs").update({ status: "ongoing" }).eq("id", job.job_id);   // un-freeze
  if (upd.error) throw new Error(upd.error.message);
  return {};
}
```

- [ ] **Step 3: Verify `weekContaining`'s return shape.** Read `shared/payweek.mjs` and confirm `weekContaining(isoDate)` accepts a `'YYYY-MM-DD'` string and returns the Saturday `week_start` as `'YYYY-MM-DD'` (same value `v_week_payroll_health.week_start` uses). If it needs a `Date`, wrap with `new Date(r.work_date)` in `closedWeekWarning`.

- [ ] **Step 4: Integration verify** — `scratchpad/verify-jobclose-flow.mjs` against a **TEST job** (create `jobs` row `job_no='JOB-TEST-CLOSE'`, quantity 100, unit 'kg', calibrated false; add one `job_progress` row cum 60):
  1. set `owner_pin` absent → `approveJob` throws `OWNER_PIN_NOT_SET`.
  2. `closeJobOrder` with wrong coord PIN throws; with right PIN → `job_close` row (credited=min(installed,100), overrun if installed>100, discrepancy vs 60), audit `operational_close`, `jobs.status='closed'`; a follow-up `job_progress` insert is rejected by the backstop.
  3. `approveJob` while uncalibrated throws "Calibrate…"; calibrate the test job, `setOwnerPin('4321')`, approve → audit `incentive_approve`; `settings_audit` has a `set` row.
  4. `reopenJob` with owner PIN → audit `reopen`, `jobs.status='ongoing'`, progress writes accepted again.
  5. Delete all TEST rows (`job_close`, `job_close_audit` for the test job, the test `jobs`/`job_progress`/`settings owner_pin`/`settings_audit` rows).

Run: `node scratchpad/verify-jobclose-flow.mjs`
Expected: prints `CLOSE FLOW OK` with each assertion passing.

- [ ] **Step 5: Validate + commit** — `node --check` is N/A for config.js (module, not HTML). Run `node monitoring/jobclose.test.mjs` (still green). Hygiene: `grep -c wpmcbjrisuyjvobvzaus monitoring/config.js` (>=1), `grep -c azfmpleswqixaslvcito monitoring/config.js` (0).

```bash
git add monitoring/config.js
git commit -m "feat(kpi): config helpers — close/approve/reopen job + owner-PIN (server-side, audited)"
```

---

### Task 4: efficiency.html — By-job close UI (badges, close form, approve/reopen)

**Files:**
- Modify: `monitoring/efficiency.html` (read current file first; `JobView` is ~lines 197-221, `toggleCalib` ~181-194, `actor` state ~80/88, imports ~64).

**Interfaces:**
- Consumes from `config.js`: `loadAllJobCloseStatus`, `closeJobOrder`, `approveJob`, `reopenJob`, `checkOwnerPin`, `setOwnerPin`, `closedWeekWarning`, `computeDiscrepancy` (via `jobclose.mjs`), `fmtNum`.

- [ ] **Step 1: Extend the import** (efficiency.html:64) to add the new helpers:

```js
import { sb, loadEmployees, fmtNum, defaultPayWeek,
         loadAllJobCloseStatus, closeJobOrder, approveJob, reopenJob,
         setOwnerPin, closedWeekWarning } from "./config.js";
import { computeDiscrepancy } from "./jobclose.mjs";
```

- [ ] **Step 2: Add state + status loading.** Near the other `useState` in the By-job component, add `const [closeStatus,setCloseStatus]=useState({});` and load it wherever `loadJobs()` runs:

```js
async function loadJobs(){
  const { data } = await sb.from("v_job_efficiency").select("*").order("job_no");
  setJobs(data||[]);
  setCloseStatus(await loadAllJobCloseStatus());
}
```
(Match the existing `loadJobs` body; only add the `setCloseStatus` line and keep the existing select.)

- [ ] **Step 3: Add status badges + action buttons** in `JobView`'s per-job render. After the existing badges block, add:

```js
${(()=>{ const cs=(closeStatus[j.job_id]||{}).status||"open";
  if(cs==="pending") return html`<span class="badge amber">pending incentive approval</span>`;
  if(cs==="approved") return html`<span class="badge ok">approved</span>`;
  return null; })()}
```

And replace the single calibrate-button footer with a footer that branches on close status:

```js
${(()=>{ const cs=(closeStatus[j.job_id]||{}).status||"open"; const noTarget=(j.quantity==null);
  if(cs==="open") return html`<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
    ${!noTarget && html`<button class="mini" disabled=${busy} onClick=${()=>toggleCalib(j)}>${j.calibrated?"Un-calibrate":"Mark calibrated (admin)"}</button>`}
    <button class="mini" disabled=${busy} onClick=${()=>openClose(j)}>Close job order (coordinator)</button>
  </div>`;
  if(cs==="pending") return html`<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
    <button class="primary" style="width:auto;margin:0" disabled=${busy||!j.calibrated} onClick=${()=>doApprove(j)}>Approve for incentive (owner)</button>
    ${!j.calibrated && html`<span class="sub">calibrate first</span>`}
    <button class="ghost" style="width:auto;margin:0" disabled=${busy} onClick=${()=>doReopen(j)}>Reopen (owner)</button>
  </div>`;
  return html`<div style="margin-top:8px"><button class="ghost" style="width:auto;margin:0" disabled=${busy} onClick=${()=>doReopen(j)}>Reopen (owner)</button></div>`;
})()}
```

- [ ] **Step 4: Add the close-form modal state + handlers** (near `toggleCalib`). Uses `actor` as the typed coordinator/owner name (existing field), and `prompt()` for PINs to match the app's lightweight style:

```js
const [closeForm,setCloseForm]=useState(null);   // {job, actual, lastCum, warn:[]}

async function openClose(j){
  const { data:lr } = await sb.from("job_progress").select("units_cumulative").eq("job_id",j.job_id).order("work_date",{ascending:false}).limit(1);
  const lastCum=(lr&&lr[0])?Number(lr[0].units_cumulative):null;
  setCloseForm({ job:j, actual: lastCum!=null?String(lastCum):"", lastCum, warn:[] });
}
async function submitClose(){
  const f=closeForm; const actual=Number(f.actual);
  if(!f.actual.trim()||isNaN(actual)){ setMsg({type:"err",text:"Enter the actual-installed quantity."}); return; }
  if(!actor.trim()){ setMsg({type:"err",text:"Enter your name (coordinator)."}); return; }
  const coordPin=prompt("Coordinator passcode:"); if(coordPin==null) return;
  setBusy(true);
  try{
    const warn=await closedWeekWarning(f.job.job_id, actual, f.lastCum);
    if(warn.length && !confirm(`Heads up: this changes earned hours in already-closed week(s): ${warn.join(", ")}. Those frozen weeks will NOT recalculate. Continue closing the job?`)){ setBusy(false); return; }
    await closeJobOrder(f.job, { actualInstalled:actual, coordinator:actor.trim(), coordPin });
    setCloseForm(null); setMsg({type:"ok",text:"Job closed — pending incentive approval."}); await loadJobs();
  }catch(e){ setMsg({type:"err",text:e.message}); }
  setBusy(false);
}
async function doApprove(j){
  if(!actor.trim()){ setMsg({type:"err",text:"Enter your name (owner)."}); return; }
  let pin=prompt("Owner passcode:"); if(pin==null) return;
  setBusy(true);
  try{
    await approveJob(j, { ownerPin:pin, owner:actor.trim() });
    setMsg({type:"ok",text:"Job approved for incentive."}); await loadJobs();
  }catch(e){
    if(e.message==="OWNER_PIN_NOT_SET"){ await forceSetOwnerPin(); }
    else setMsg({type:"err",text:e.message});
  }
  setBusy(false);
}
async function doReopen(j){
  if(!actor.trim()){ setMsg({type:"err",text:"Enter your name (owner)."}); return; }
  const reason=prompt("Reason for reopening this job?")||""; if(reason===null) return;
  const pin=prompt("Owner passcode:"); if(pin==null) return;
  setBusy(true);
  try{ await reopenJob(j, { ownerPin:pin, owner:actor.trim(), reason }); setMsg({type:"ok",text:"Job reopened (logged)."}); await loadJobs(); }
  catch(e){ if(e.message==="OWNER_PIN_NOT_SET"){ await forceSetOwnerPin(); } else setMsg({type:"err",text:e.message}); }
  setBusy(false);
}
async function forceSetOwnerPin(){
  const p1=prompt("No owner passcode is set yet. Create one now (owner only):"); if(!p1) return;
  const p2=prompt("Re-enter the new owner passcode:"); if(p2!==p1){ setMsg({type:"err",text:"Passcodes did not match."}); return; }
  try{ await setOwnerPin(p1, actor.trim()||null); setMsg({type:"ok",text:"Owner passcode set. Try the action again."}); }
  catch(e){ setMsg({type:"err",text:e.message}); }
}
```

Note: `approveJob`/`reopenJob` perform the server-side owner-PIN check themselves and throw `OWNER_PIN_NOT_SET` when unset; the handlers only catch that to trigger `forceSetOwnerPin`. No separate client-side PIN check is needed here.

- [ ] **Step 5: Render the close-form modal** (add near the JobView return, shown when `closeForm` is set):

```js
${closeForm && html`<div class="modal-bg" onClick=${e=>{ if(e.target===e.currentTarget) setCloseForm(null); }}>
  <div class="modal">
    <h3 style="margin:0 0 8px">Close ${closeForm.job.job_no}</h3>
    <div class="fig"><span>target <b>${closeForm.job.quantity==null?"—":fmtNum(closeForm.job.quantity)}</b></span>
      <span>last roll-call <b>${closeForm.lastCum==null?"—":fmtNum(closeForm.lastCum)}</b></span></div>
    <label style="margin-top:8px">Actual installed (${closeForm.job.unit||"units"})</label>
    <input value=${closeForm.actual} onInput=${e=>setCloseForm({...closeForm, actual:e.target.value})} inputmode="decimal" />
    ${(()=>{ const a=Number(closeForm.actual); if(!closeForm.actual.trim()||isNaN(a)) return null;
      const d=computeDiscrepancy(a, closeForm.lastCum, closeForm.job.unit||"units");
      const over=(closeForm.job.quantity!=null && a>closeForm.job.quantity);
      return html`<div class="infobox" style="margin-top:8px">${d.text}${over?" · overrun (over target — extra units not payable)":""}</div>`; })()}
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="primary" style="margin:0" disabled=${busy} onClick=${submitClose}>Confirm close</button>
      <button class="ghost" style="margin:0" disabled=${busy} onClick=${()=>setCloseForm(null)}>Cancel</button>
    </div>
  </div>
</div>`}
```

- [ ] **Step 6: Add modal CSS** (in the `<style>` block, near `.infobox`):

```css
.modal-bg{position:fixed;inset:0;background:rgba(20,26,38,.45);display:flex;align-items:center;justify-content:center;padding:16px;z-index:50}
.modal{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:16px;max-width:420px;width:100%}
```

- [ ] **Step 7: Validate** — extract the largest inline `<script>` and `node --check` it (see repo pattern); confirm no `&amp;` and correct project ref via `config.js`.

Run: `node scratchpad/extract-check.mjs` (adapt the existing helper to point at `monitoring/efficiency.html`)
Expected: `node --check: PASS`; `&amp;` count 0.

- [ ] **Step 8: E2E walkthrough (local, TEST job)** — serve locally, drive with Playwright on `JOB-TEST-CLOSE`: open By-job → Close job order → enter actual → discrepancy shows → coordinator PIN → badge "pending" → Approve blocked until calibrated → calibrate → Approve prompts owner-PIN setup (unset) → set → approved badge → Reopen → back to open. Confirm audit rows via a query.

- [ ] **Step 9: PAUSE for the owner's localhost walkthrough** (interactive page — deploy rule). Do NOT push yet. On the owner's "go", commit:

```bash
git add monitoring/efficiency.html
git commit -m "feat(kpi): close-job UI on By-job view — close form, approve/reopen, owner-PIN gate"
```

---

### Task 5: roll-call.html + assign.html — exclude closed jobs

**Files:**
- Modify: `monitoring/roll-call.html` (job list filter, ~line 130: `.neq("status","done")`)
- Modify: `monitoring/assign.html` (job list filter, ~line 99: `.neq("status","done")`)

- [ ] **Step 1: Read both current files** and locate each jobs query using `.neq("status","done")`.

- [ ] **Step 2: Replace** each `.neq("status","done")` with an exclusion of both closed and done, using PostgREST `not.in`:

```js
.not("status","in","(done,closed)")
```
(If the existing call chains differently, keep everything else identical — only broaden the status exclusion so a `status='closed'` job disappears from the taggable/active list.)

- [ ] **Step 3: Validate** — `node --check` the largest inline script of each file; `&amp;` count 0.

- [ ] **Step 4: E2E** — with `JOB-TEST-CLOSE` set to `status='closed'`, load roll-call and assign: the test job is absent from the list. Reopen it (status back to 'ongoing') → it reappears.

- [ ] **Step 5: PAUSE for owner walkthrough** (interactive pages), then on "go":

```bash
git add monitoring/roll-call.html monitoring/assign.html
git commit -m "feat(kpi): hide closed jobs from roll-call and assignment lists"
```

---

### Task 6: home.js — Job Monitoring tile + owner-PIN setter

**Files:**
- Modify: `home.js` (Operations tiles ~1531-1554; admin PIN setters ~718-727; `setSetting` ~243-246; `supabase` client in-file).

**Interfaces:**
- Consumes: existing `setSetting`, `flash`, `supabase`, `Tile`, admin-dashboard render.

- [ ] **Step 1: Read the current home.js** admin-dashboard render and PIN-setter block.

- [ ] **Step 2: Add the Job Monitoring tile** to the Operations grid (~1531-1540), following the `href` pattern:

```js
{ ico:'📊', num:null, unit:'close & approve jobs', title:'Job Monitoring', href:'../monitoring/' },
```

- [ ] **Step 3: Add owner-PIN state + setter.** Near `coordPin`/`saveCoordPin` state and handlers, add:

```js
const [ownerPin,setOwnerPin]=useState('');
async function saveOwnerPin(){
  if(!ownerPin.trim()){ flash('Enter a passcode'); return; }
  try{
    const existed=(await getSetting('owner_pin'))!=null;
    await setSetting('owner_pin', ownerPin.trim());
    await supabase.from('settings_audit').insert({ key:'owner_pin', action: existed?'change':'set', actor: (localStorage.getItem('rsr_prepared_by')||null) });
    setOwnerPin(''); flash(existed?'Owner passcode changed':'Owner passcode set');
  }catch(e){ flash('Failed: '+e.message); }
}
```
(Use a local name that doesn't collide with the imported `setOwnerPin` from config.js — home.js does NOT import config.js, so the `useState` setter name is fine here.)

- [ ] **Step 4: Add the owner-PIN input** in the PIN-setters area (beside "Assistant passcode" / "Issuance passcode"), with a "no default — set your own" note:

```js
html`<div class="pinrow">
  <label>Owner passcode (incentive approval — no default; set your own)</label>
  <input type="password" value=${ownerPin} onInput=${e=>setOwnerPin(e.target.value)} placeholder="choose a passcode" />
  <button class="mini" onClick=${saveOwnerPin}>Save owner passcode</button>
</div>`
```
(Match the exact markup/classes of the adjacent coordinator/issuance PIN rows in the current file.)

- [ ] **Step 5: Validate** — `node --check` the largest inline script of `home.js`'s host HTML if inline, else `node --check home.js` directly (it's a module). Confirm no `&amp;`.

- [ ] **Step 6: E2E** — admin dashboard: the Job Monitoring tile opens `../monitoring/`; saving an owner passcode writes `settings.owner_pin` + a `settings_audit` `set` row (query to confirm); changing it writes a `change` row.

- [ ] **Step 7: PAUSE for owner walkthrough** (interactive), then on "go":

```bash
git add home.js
git commit -m "feat(kpi): Job Monitoring dashboard tile + owner-PIN setter (audited, no default)"
```

---

### Task 7 (optional): status badge on monitor.html / job-order.html

**Files:**
- Modify: `monitoring/monitor.html` (job header ~141-163), `monitoring/job-order.html` (recent list ~254-265).

- [ ] **Step 1:** In each, load close status (`loadAllJobCloseStatus` from config.js) and render a small badge (`pending incentive approval` / `approved`) beside the existing status pill, mirroring Task 4's badge markup. Purely additive/read-only.
- [ ] **Step 2:** `node --check`, no `&amp;`, then PAUSE for walkthrough and commit:

```bash
git add monitoring/monitor.html monitoring/job-order.html
git commit -m "feat(kpi): show close/approved status badge on monitor + job-order lists"
```

---

## Post-implementation

- Run the whole-branch review (subagent-driven-development's final review).
- Update memory `close-job-order-feature.md`: mark BUILT, note the tables/helpers/UI shipped, and that Phase-2 (peso settlement) remains queued.
- Final owner walkthrough of the full flow on localhost, then push all interactive-page commits together on the owner's go; hand the owner the SQL to run first (Task 2) if not already applied.
