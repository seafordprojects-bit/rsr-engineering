# Job Vessel Integration — Project A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Job Order free-text Vessel field with a dropdown of active-in-yard vessels, link each new job to its voyage, and flag still-open jobs whose vessel has left the yard on three surfaces — no auto-close.

**Architecture:** Pure lifecycle logic lives in a new `monitoring/vessel.mjs` (node-testable, like `jobclose.mjs`). `config.js` re-exports it and adds Supabase loaders. `job-order.html` uses the loader for its dropdown; three read surfaces (`roll-call.html`, `efficiency.html`, `coordinator.js`) render a badge via the pure helper. One additive `jobs.voyage_id` column (owner runs the SQL).

**Tech Stack:** Vanilla JS + Preact/htm via CDN (no build step). Supabase project `wpmcbjrisuyjvobvzaus` (RLS off, PostgREST). Playwright + msedge E2E in `scratchpad/nd-e2e/`, server on `localhost:8137`.

## Global Constraints

- Supabase project is `wpmcbjrisuyjvobvzaus` ONLY. Never `azfmpleswqixaslvcito`. Hygiene-grep every changed deliverable: `wpmcbjrisuyjvobvzaus` present where a URL is embedded, `azfmpleswqixaslvcito` absent (0).
- Complete files only when handing to the owner; validate before shipping: `node --check` on the largest inline `<script>` of any changed HTML (via `scratchpad/validate.mjs`).
- htm template literals use a **literal `&`** and **real unicode characters** (`…`, `→`, `×`, `·`, `⚠`), NEVER HTML entities — htm renders entities literally.
- SQL uses `--` comments, never `//`.
- Active-in-yard rule (verbatim, from `tools/index.html:539–546`): exclude `status==='finished'||'not_active'`; active if `(docking_date||status==='drydock')&&!undocking_date` OR `afloat_start&&!afloat_done` OR `emergency_start&&!emergency_end`.
- Vessel dropdown offers ALL active vessels regardless of yard (owner-approved; no yard filtering).
- Flag message names the most-recently-ended phase (latest end date): "Vessel undocked" / "Afloat repair ended" / "Emergency repair ended" / else "Vessel left the yard", suffixed " — close this job order".
- No auto-close; flag is display-only. Forward-looking only: jobs with no `voyage_id` are never flagged.
- Worker/coordinator-facing → walkthrough before push (SDD gate). Owner runs the ALTER SQL.

## File Structure

- **Create** `monitoring/vessel.mjs` — pure helpers `activeInYard(v)`, `vesselFlag(job, voyageById)`. No Supabase import (node-testable).
- **Modify** `monitoring/config.js` — re-export the two helpers; add `loadActiveVoyages()` and `loadVoyagesById()`.
- **Modify** `monitoring/job-order.html` — vessel dropdown, `voyage_id` + name snapshot on insert, submit re-check, no-vessels state, stamp.
- **Modify** `monitoring/roll-call.html` — fetch voyages, render flag badge on each job card, stamp.
- **Modify** `monitoring/efficiency.html` — fetch voyages, render flag badge on each By-job card, stamp.
- **Modify** `coordinator.js` — fetch voyages, render flag badge in the read-only roll-call view, cache-bust.
- **Create** `monitoring/sql/job-voyage-link.sql` — the additive `jobs.voyage_id` ALTER (owner runs).
- **Create** `scratchpad/nd-e2e/vessel-unit.mjs` — node unit test of the pure helpers.
- **Create** `scratchpad/nd-e2e/job-vessel.mjs` — Playwright E2E (dropdown, submit, submit re-check, flag on all 3 surfaces).
- **Modify** `scratchpad/nd-e2e/run-all.mjs`, `preflight.html`, `coordinator/index.html`.

---

### Task 1: Pure lifecycle helpers `monitoring/vessel.mjs`

**Files:**
- Create: `monitoring/vessel.mjs`
- Test: `scratchpad/nd-e2e/vessel-unit.mjs`

**Interfaces:**
- Produces: `activeInYard(voyage) -> boolean`; `vesselFlag(job, voyageById) -> null | {reason:string, message:string}`. `voyageById` is a `Map` OR a plain object keyed by voyage id. `job` has `{voyage_id, status}`.

- [ ] **Step 1: Write the failing test** — Create `scratchpad/nd-e2e/vessel-unit.mjs`:

```js
// Node unit test (pure, no browser): monitoring/vessel.mjs lifecycle helpers.
// scratchpad/ lives in a different directory tree from the repo, so import via absolute file URL.
import { activeInYard, vesselFlag } from 'file:///C:/Users/PC/Documents/rsr-engineering/monitoring/vessel.mjs';
let fail = 0;
const ok = (c, m) => { console.log((c ? '[PASS] ' : '[FAIL] ') + m); if (!c) fail++; };

// activeInYard
ok(activeInYard({ status: 'drydock', docking_date: '2026-07-01', undocking_date: null }) === true, 'drydock active');
ok(activeInYard({ docking_date: '2026-07-01', undocking_date: '2026-07-10' }) === false, 'undocked → inactive');
ok(activeInYard({ afloat_start: '2026-07-05', afloat_done: null }) === true, 'afloat active');
ok(activeInYard({ afloat_start: '2026-07-05', afloat_done: '2026-07-09' }) === false, 'afloat done → inactive');
ok(activeInYard({ emergency_start: '2026-07-06', emergency_end: null }) === true, 'emergency active');
ok(activeInYard({ status: 'finished', afloat_start: '2026-07-01' }) === false, 'finished → inactive');
ok(activeInYard({ status: 'not_active' }) === false, 'not_active → inactive');
ok(activeInYard(null) === false, 'null → inactive');

// vesselFlag
const V = { vX: { id: 'vX', vessel_name: 'MV X', undocking_date: '2026-07-10', docking_date: '2026-07-01' } };
const byId = new Map(Object.entries(V));
ok(vesselFlag({ voyage_id: 'vX', status: 'open' }, byId)?.reason === 'Vessel undocked', 'open + undocked → undocked flag');
ok(vesselFlag({ voyage_id: 'vX', status: 'open' }, byId).message === 'Vessel undocked — close this job order', 'flag message text');
ok(vesselFlag({ voyage_id: 'vX', status: 'closed' }, byId) === null, 'closed job → no flag');
ok(vesselFlag({ voyage_id: 'vX', status: 'done' }, byId) === null, 'done job → no flag');
ok(vesselFlag({ voyage_id: null, status: 'open' }, byId) === null, 'no voyage_id → no flag');
ok(vesselFlag({ voyage_id: 'vMissing', status: 'open' }, byId) === null, 'missing voyage → no flag');
ok(vesselFlag({ voyage_id: 'vA', status: 'open' }, { vA: { id: 'vA', afloat_start: '2026-07-01', afloat_done: null } }) === null, 'active vessel → no flag');
ok(vesselFlag({ voyage_id: 'vA', status: 'open' }, { vA: { id: 'vA', afloat_start: '2026-07-01', afloat_done: '2026-07-12' } })?.reason === 'Afloat repair ended', 'afloat ended flag');
// latest end date wins
ok(vesselFlag({ voyage_id: 'vB', status: 'open' }, { vB: { id: 'vB', undocking_date: '2026-07-05', afloat_done: '2026-07-20' } })?.reason === 'Afloat repair ended', 'latest end phase named');

console.log(`\n${fail ? '✗ vessel-unit: ' + fail + ' FAILED' : '✓ vessel-unit: all passed'}`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it, verify it fails** — `cd scratchpad/nd-e2e && node vessel-unit.mjs`. Expected: FAIL — `Cannot find module .../monitoring/vessel.mjs`.

- [ ] **Step 3: Create `monitoring/vessel.mjs`:**

```js
/* ============================================================
   vessel.mjs — pure vessel-lifecycle helpers (no Supabase import → node-testable,
   mirrors jobclose.mjs). A voyage row comes from the `voyages` table.
   ============================================================ */

// Is the vessel currently in the yard (an active repair phase)? Mirrors the tool-borrow /
// material-issuance filter byte-for-byte.
export function activeInYard(v){
  if(!v) return false;
  if(v.status==='finished' || v.status==='not_active') return false;
  const dry=(v.docking_date || v.status==='drydock') && !v.undocking_date;
  const afl=v.afloat_start && !v.afloat_done;
  const eme=v.emergency_start && !v.emergency_end;
  return !!(dry||afl||eme);
}

// Flag an OPEN job whose linked vessel has LEFT the yard. Returns null (no flag) or
// { reason, message }. `voyageById` maps voyage_id -> voyage row (a Map or a plain object).
export function vesselFlag(job, voyageById){
  if(!job || !job.voyage_id) return null;                       // legacy / unlinked → never flagged
  const st=String(job.status||"").toLowerCase();
  if(st==="done" || st==="closed") return null;                 // already finished
  const v=voyageById && (voyageById.get ? voyageById.get(job.voyage_id) : voyageById[job.voyage_id]);
  if(!v) return null;                                           // vessel row missing → don't flag
  if(activeInYard(v)) return null;                              // still in the yard → no flag
  const ends=[
    { reason:"Vessel undocked",        d:v.undocking_date },
    { reason:"Afloat repair ended",    d:v.afloat_done },
    { reason:"Emergency repair ended", d:v.emergency_end },
  ].filter(x=>x.d);
  ends.sort((a,b)=> String(b.d).localeCompare(String(a.d)));    // latest end date first
  const reason = ends.length ? ends[0].reason : "Vessel left the yard";
  return { reason, message: reason + " — close this job order" };
}
```

- [ ] **Step 4: Run it, verify it passes** — `node vessel-unit.mjs`. Expected: `✓ vessel-unit: all passed`.

- [ ] **Step 5: Commit** — `git add monitoring/vessel.mjs scratchpad/nd-e2e/vessel-unit.mjs` (note: scratchpad is git-ignored; commit only `monitoring/vessel.mjs`). `git commit -m "feat(monitoring): vessel lifecycle helpers (activeInYard, vesselFlag)"`.

---

### Task 2: Supabase loaders in `config.js`

**Files:**
- Modify: `monitoring/config.js` (add after `loadLocations`, ~line 44)

**Interfaces:**
- Consumes: `activeInYard`, `vesselFlag` from `./vessel.mjs`.
- Produces: `loadActiveVoyages() -> Promise<voyage[]>` (active only, sorted by name); `loadVoyagesById() -> Promise<Map<id,voyage>>` (ALL voyages); re-exports `activeInYard`, `vesselFlag`.

- [ ] **Step 1:** Add near the top of `config.js` imports (after line 10):

```js
import { activeInYard, vesselFlag } from "./vessel.mjs";
export { activeInYard, vesselFlag };
```

- [ ] **Step 2:** Add these two loaders after `loadLocations()` (after line 44):

```js
/* ---- vessel schedule (voyages) — read-only from the coordinator's table ---- */
// Active-in-yard vessels for the Job Order dropdown.
export async function loadActiveVoyages(){
  const { data, error } = await sb.from("voyages")
    .select("id,vessel_name,vessel_code,status,docking_date,undocking_date,afloat_start,afloat_done,emergency_start,emergency_end")
    .order("vessel_name");
  if(error){ console.error("loadActiveVoyages", error); return []; }
  return (data||[]).filter(activeInYard);
}
// ALL voyages keyed by id — for the lifecycle flag (a flagged job's vessel is INACTIVE, so it is
// NOT in loadActiveVoyages()).
export async function loadVoyagesById(){
  const { data, error } = await sb.from("voyages")
    .select("id,vessel_name,status,docking_date,undocking_date,afloat_start,afloat_done,emergency_start,emergency_end");
  if(error){ console.error("loadVoyagesById", error); return new Map(); }
  const m=new Map(); (data||[]).forEach(v=>m.set(v.id,v)); return m;
}
```

- [ ] **Step 3: Validate** — `node --check monitoring/config.js`. Expected: no output (OK). (Loaders are covered by the E2E in later tasks; no standalone test here.)

- [ ] **Step 4: Commit** — `git add monitoring/config.js && git commit -m "feat(monitoring): config voyage loaders + re-export vessel helpers"`.

---

### Task 3: Vessel dropdown + linked insert + submit re-check (`job-order.html`)

**Files:**
- Modify: `monitoring/job-order.html` (imports; state ~line 90s; `refresh` ~109; `save` ~152; vessel field ~187–188; stamp)
- Test: `scratchpad/nd-e2e/job-vessel.mjs` (dropdown + submit sections)

**Interfaces:**
- Consumes: `loadActiveVoyages`, `activeInYard` from `./config.js`.
- Produces: `jobs` insert now carries `voyage_id` (picked voyage id) and `vessel` (its `vessel_name`).

- [ ] **Step 1: Write the failing E2E** — Create `scratchpad/nd-e2e/job-vessel.mjs` with the dropdown+submit checks (mock `voyages`, `work_tariff`, `correction_factor`, `jobs`, and the `next_job_no` RPC). Assert: (a) the Vessel control is a `<select>`, not a text input; (b) it lists exactly the active vessels and none of the inactive ones; (c) picking a vessel + a work item + qty and saving POSTs a `jobs` row whose `voyage_id` is the picked id and `vessel` is its name; (d) if the mocked voyage is inactive at submit time, the save is refused and nothing is POSTed. (Full harness pattern: copy the route-mock + goto approach from `scratchpad/nd-e2e/roll-call-site.mjs`; the job-order page imports config.js so its importmap resolves in msedge.) Block service workers (`serviceWorkers:'block'`).

- [ ] **Step 2: Run it, verify it fails** — `node job-vessel.mjs`. Expected: FAIL (still a text input; no voyage_id posted).

- [ ] **Step 3a: Imports** — in the `<script type="module">` import from `./config.js`, add `loadActiveVoyages, activeInYard` to the existing import list.

- [ ] **Step 3b: State** — replace the free-text vessel state with voyage state. Find `const [vessel,setVessel]=useState("");` and replace with:

```js
      const [voyages,setVoyages]=useState([]);   // active-in-yard vessels for the dropdown
      const [voyageId,setVoyageId]=useState("");
```

- [ ] **Step 3c: Load voyages** — in `refresh()` (line 112), add `loadActiveVoyages()` to the parallel load and store it:

```js
        const [ir,fr,js,vs]=await Promise.all([iq,fq,fetchJobs(),loadActiveVoyages()]);
```
and after `setJobs(js);` (line 120) add: `setVoyages(vs||[]);`

- [ ] **Step 3d: Vessel field** — replace lines 187–188 (`<label>Vessel</label>` + the `<input .../>`) with:

```js
          <label>Vessel</label>
          ${voyages.length===0
            ? html`<div class="hint">No vessels are in the yard right now. Add one in the coordinator vessel schedule first.</div>`
            : html`<select value=${voyageId} onChange=${e=>setVoyageId(e.target.value)}>
                <option value="">— Select vessel —</option>
                ${voyages.map(v=>html`<option value=${v.id}>${v.vessel_name}</option>`)}
              </select>`}
```

- [ ] **Step 3e: Save** — in `save()`: replace the vessel validation (line 154) with a voyage pick + submit re-check, and update the insert + reset.

Replace `if(!vessel.trim()) return setMsg({type:"err",text:"Enter the vessel."});` with:

```js
        const voyage=voyages.find(v=>v.id===voyageId);
        if(!voyage) return setMsg({type:"err",text:"Select a vessel."});
```

Immediately after `setBusy(true);` (line 157) add the submit re-check:

```js
          // Part 3 backstop: the vessel may have undocked between opening the form and now.
          const { data:freshV } = await sb.from("voyages")
            .select("id,vessel_name,status,docking_date,undocking_date,afloat_start,afloat_done,emergency_start,emergency_end")
            .eq("id",voyageId).maybeSingle();
          if(!freshV || !activeInYard(freshV)){ setBusy(false); return setMsg({type:"err",text:"That vessel has left the yard — pick another vessel."}); }
```

In the `jobs.insert({...})` object, replace `vessel:vessel.trim(),` with `voyage_id:voyageId, vessel:voyage.vessel_name,`.

In the success reset (line 176), replace `setVessel("");` with `setVoyageId("");`.

- [ ] **Step 3f: Stamp** — bump the page's version stamp if present (search the file for `v2026-07`); if none exists in the header, add one to match the deploy convention. Note the stamp value for Task 7's preflight update.

- [ ] **Step 4: Validate + run** — `node scratchpad/validate.mjs monitoring/job-order.html` (node --check OK; hygiene: config-imported URL so `wpmc MISSING` is the known/expected false-alarm, `azfm` absent). Then `node scratchpad/nd-e2e/job-vessel.mjs` → the dropdown + submit checks PASS.

- [ ] **Step 5: Commit** — `git add monitoring/job-order.html && git commit -m "feat(job-order): vessel dropdown from voyages + voyage_id link + submit re-check"`.

---

### Task 4: Lifecycle flag on Roll-call (`roll-call.html`)

**Files:**
- Modify: `monitoring/roll-call.html` (imports; App state + reload; job card render ~ the `.job` card; a `.vflag` CSS rule; stamp)
- Test: `scratchpad/nd-e2e/job-vessel.mjs` (roll-call flag section)

**Interfaces:**
- Consumes: `loadVoyagesById`, `vesselFlag` from `./config.js`. Job cards render from the App's `jobs` array; each job needs `voyage_id` + `status` — extend the jobs select to include them.

- [ ] **Step 1: Write the failing check** — in `job-vessel.mjs`, add a section that loads `roll-call.html?site=Carmen`, passes the gate (mock `roll_call_pin` + device), mocks `jobs` (one open job linked to an undocked voyage, one linked to an active voyage) and `voyages`, and asserts the badge text "Vessel undocked — close this job order" appears on the undocked-vessel job card and NOT on the active-vessel job card.

- [ ] **Step 2: Run it, verify it fails** — `node job-vessel.mjs`. Expected: the new roll-call assertions FAIL (no badge yet).

- [ ] **Step 3a: Imports** — add `loadVoyagesById, vesselFlag` to the `./config.js` import in `roll-call.html`.

- [ ] **Step 3b: Jobs select** — in `reload()`, the `jobs` select currently lists columns without `voyage_id`/`status` guaranteed; ensure the select includes `id,job_no,vessel,location,start_date,target_date,status,est_manhours,quantity,unit,site,voyage_id` (add `voyage_id` and confirm `status` present).

- [ ] **Step 3c: Load voyages** — add App state `const [voyById,setVoyById]=useState(new Map());`. In the `useEffect(()=>{ loadEmployees()... },[])` init, also call `loadVoyagesById().then(setVoyById)`.

- [ ] **Step 3d: Render the badge** — inside the job card (the `.job` block, after the `.jhead`/`.jno` line), insert:

```js
                  ${(()=>{ const f=vesselFlag(j, voyById); return f? html`<div class="vflag">⚠ ${f.message}</div>` : ""; })()}
```
(`j` is the job in the `jobs.map(j=>...)`; `⚠` is ⚠.)

- [ ] **Step 3e: CSS** — add to the page `<style>`:

```css
  .vflag{background:#fbe8e7;border:1px solid #f0bdba;color:#b4231f;border-radius:8px;padding:4px 8px;font-size:11px;font-weight:700;margin-top:6px}
```

- [ ] **Step 3f: Stamp** — bump the roll-call.html stamp (currently `v2026-07-16d` → next letter). Record for Task 7.

- [ ] **Step 4: Validate + run** — `node scratchpad/validate.mjs monitoring/roll-call.html` (node --check OK). `node scratchpad/nd-e2e/job-vessel.mjs` → roll-call flag checks PASS.

- [ ] **Step 5: Commit** — `git add monitoring/roll-call.html && git commit -m "feat(roll-call): vessel-undocked flag on job cards"`.

---

### Task 5: Lifecycle flag on By-job efficiency view (`efficiency.html`)

**Files:**
- Modify: `monitoring/efficiency.html` (imports; the By-job job list render; `.vflag` CSS; stamp)
- Test: `scratchpad/nd-e2e/job-vessel.mjs` (efficiency flag section)

**Interfaces:**
- Consumes: `loadVoyagesById`, `vesselFlag` from `./config.js`. The By-job render must have `voyage_id` + `status` on each job — extend its jobs query.

- [ ] **Step 1: Write the failing check** — in `job-vessel.mjs`, add a section that opens `efficiency.html` (pass its PIN/gate; copy from `scratchpad/nd-e2e/payroll-editpreview.mjs` or the existing efficiency-driving test if present), mocks the By-job data with one open job on an undocked vessel, and asserts the "close this job order" badge renders next to that job.

- [ ] **Step 2: Run it, verify it fails** — badge absent → FAIL.

- [ ] **Step 3: Implement** — read `efficiency.html`, find where the By-job list maps jobs to cards. Add `loadVoyagesById, vesselFlag` to the config import; fetch voyages into a `voyById` variable/state on load; ensure the job objects carry `voyage_id` + `status` (extend the select if needed); render the same badge markup as Task 4 (`<div class="vflag">⚠ ${f.message}</div>`) on each job card; add the `.vflag` CSS rule (verbatim from Task 4 Step 3e); bump the stamp. Use a real `⚠` character, not `&#9888;`/entity.

- [ ] **Step 4: Validate + run** — `node scratchpad/validate.mjs monitoring/efficiency.html`; `node job-vessel.mjs` → efficiency flag check PASS.

- [ ] **Step 5: Commit** — `git add monitoring/efficiency.html && git commit -m "feat(efficiency): vessel-undocked flag on By-job cards"`.

---

### Task 6: Lifecycle flag on the coordinator read-only view (`coordinator.js`)

**Files:**
- Modify: `coordinator.js` (the read-only roll-call view render; a voyage loader using the coordinator's own `sb`; `.vflag` CSS in `coordinator/index.html`)
- Test: `scratchpad/nd-e2e/job-vessel.mjs` (coordinator flag section) — reuse `scratchpad/nd-e2e/coord-rollcall-drive.mjs` as the driving pattern.

**Interfaces:**
- Consumes: the pure `vesselFlag`. If `coordinator.js` is an ES module, `import { vesselFlag } from "../monitoring/vessel.mjs";`. If it is NOT a module (classic script), inline a copy of `activeInYard` + `vesselFlag` (≈20 lines, verbatim from `vessel.mjs`) with a comment pointing back to the source of truth.

- [ ] **Step 1: Write the failing check** — in `job-vessel.mjs`, drive the coordinator read-only roll-call view (pattern from `coord-rollcall-drive.mjs`), mock a job on an undocked vessel, assert the badge renders on the job grouping.

- [ ] **Step 2: Run it, verify it fails** — FAIL (no badge).

- [ ] **Step 3: Implement** — in `coordinator.js`, add a voyage loader using the coordinator's existing supabase client: `async function getVoyagesById(){ const {data}=await supabase.from('voyages').select('id,vessel_name,status,docking_date,undocking_date,afloat_start,afloat_done,emergency_start,emergency_end'); const m=new Map(); (data||[]).forEach(v=>m.set(v.id,v)); return m; }` (match the file's client variable name — `supabase` or `sb`). Load it where the RollCall view loads its jobs; ensure the jobs query carries `voyage_id` + `status`; render `vesselFlag(job, voyById)` as `<div class="vflag">⚠ …</div>` on each job grouping. Add the `.vflag` CSS to `coordinator/index.html`'s `<style>`.

- [ ] **Step 4: Validate + run** — `node --check coordinator.js`; `node job-vessel.mjs` → coordinator flag check PASS.

- [ ] **Step 5: Commit** — `git add coordinator.js coordinator/index.html && git commit -m "feat(coordinator): vessel-undocked flag on read-only roll-call view"`.

---

### Task 7: SQL, regression wiring, stamps, deploy prep

**Files:**
- Create: `monitoring/sql/job-voyage-link.sql`
- Modify: `scratchpad/nd-e2e/run-all.mjs`, `preflight.html`, `coordinator/index.html` (cache-bust)

- [ ] **Step 1: SQL file** — create `monitoring/sql/job-voyage-link.sql`:

```sql
-- Job → vessel link for the Job Monitoring vessel integration (Project A).
-- Additive + idempotent. Existing rows keep voyage_id NULL (legacy free-text jobs, never flagged).
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS voyage_id uuid REFERENCES public.voyages(id);
CREATE INDEX IF NOT EXISTS idx_jobs_voyage ON public.jobs(voyage_id);
```

- [ ] **Step 2: Wire the suites** — add `'vessel-unit.mjs'` and `'job-vessel.mjs'` to the `SUITES` array in `scratchpad/nd-e2e/run-all.mjs` with one-line descriptions. (Note: `run-all.mjs` runs `.mjs` suites; `vessel-unit.mjs` is a pure node test and runs the same way.)

- [ ] **Step 3: Stamps + preflight** — in `preflight.html` `EXPECT`, bump `monitoring/roll-call.html` to its new stamp (Task 4) and add entries for `monitoring/job-order.html` and `monitoring/efficiency.html` at their new stamps (Tasks 3, 5) if those pages carry a stamp. Bump the `coordinator.js` cache-bust query in `coordinator/index.html` (e.g. `?v=2026-07-18a`).

- [ ] **Step 4: Full regression + hygiene** — run `node nd-e2e/run-all.mjs` from `scratchpad`; expect all suites green (prior count + `vessel-unit` + `job-vessel`). Hygiene-grep every changed file: `azfmpleswqixaslvcito` count = 0.

- [ ] **Step 5: Commit** — `git add monitoring/sql/job-voyage-link.sql preflight.html coordinator/index.html && git commit -m "chore(job-vessel): SQL migration, preflight + regression wiring, cache-bust"`.

---

## Deploy (after all tasks green)

1. Owner runs `monitoring/sql/job-voyage-link.sql` in Supabase (before the code goes live — the insert writes `voyage_id`). Re-verify the column exists independently.
2. Owner localhost walkthrough (create a job against a vessel; undock it in the coordinator app; confirm the flag appears on By-job, Roll-call, and the coordinator view; confirm an undocked vessel isn't selectable).
3. Push on explicit go; verify live stamps via cache-busted curl; tablets via `reset.html`.

## Notes for the implementer

- The Job Order page's own recent-jobs list is NOT a flag surface (only By-job, Roll-call, coordinator per the spec) — do not add the badge there.
- Existing E2E harness patterns to copy: `roll-call-site.mjs` (gate + route mock for roll-call.html), `coord-rollcall-drive.mjs` (coordinator view), `payroll-editpreview.mjs` (page-drive with PIN). Reuse `serviceWorkers:'block'` on every context (the kiosk/monitoring PWA service worker races `page.evaluate`).
- Do NOT touch close/KPI logic, the `jobs` scalar quantity/rate fields, or the earned-hours views — that is Project B.
