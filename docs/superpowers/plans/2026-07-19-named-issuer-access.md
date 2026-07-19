# Named Issuer Access — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared issuance passcode on the Tools page and Material Issuance with a per-issuer employee-PIN unlock, auto-stamp the session issuer on every slip, admin-manage the issuer list, add a 10-minute idle auto-lock, and retire the shared passcode.

**Architecture:** A server RPC `issuer_for_pin` identifies an active issuer from a typed PIN (no PINs shipped to the browser). Each page (both classic inline-script apps) stores the returned issuer for the session, auto-stamps its name on all slip write-sites, and locks on idle. `home.js` (Preact/htm admin) gets an Issuers card driven by an additive `employees.is_issuer` flag.

**Tech Stack:** Vanilla JS classic scripts (`tools/index.html`, `material-issuance/index.html`); Preact/htm (`home.js`); Supabase `wpmcbjrisuyjvobvzaus`; Playwright + msedge E2E in `scratchpad/nd-e2e/` (server on `localhost:8137`).

## Global Constraints

- Supabase project `wpmcbjrisuyjvobvzaus` ONLY; `azfmpleswqixaslvcito` must be absent (0). Hygiene-grep every changed HTML/JS.
- `node --check` the largest inline `<script>` of every changed HTML (via `scratchpad/validate.mjs`).
- Both issuance pages are ENGLISH. New strings: "Enter your PIN", "Not an authorized issuer", "Issuer: <name>", "Sign out".
- Employee PINs are 6 digits. The unlock message is the SAME for a wrong PIN and a valid-but-non-issuer PIN ("Not an authorized issuer") — do not reveal which.
- `issuer_for_pin(pin_input)` returns rows of `{id, name}` (never the PIN). `sb.rpc` returns that as an array; the issuer is `data[0]` or none.
- Auto-stamp the SESSION issuer's name to all five write-sites; the by-value is never free-text, never editable: `borrow_issuance.issued_by`, `repair_log.transmitted_by`, `tool_transfers.sent_by` (two sites), `repair_log.received_back_by`, `issuances.by_name`.
- Idle auto-lock `const IDLE_MS = 10*60*1000`; any interaction resets it; on expiry clear the session issuer and return to the login screen.
- Stop selecting `pin` client-side on both issuance pages (currently fetched-but-unused).
- Retire `settings.issuance_pin` on both pages + the admin card. Leave `app.js` (orphaned `borrower-equipments/`) alone — flag only.
- Worker/inventory-affecting → walkthrough before push. Owner runs the SQL.

## File Structure

- **Create** `named-issuer-access.sql` — `is_issuer` column + `issuer_for_pin` RPC + seed 3 issuers.
- **Modify** `home.js` — add `is_issuer` to `getEmployees` select; new "Issuers" card; remove the "Issuance (site) passcode" card + `saveSitePin` + `sitePin` state.
- **Modify** `tools/index.html` — 6-digit issuer-PIN unlock, session issuer, header display, Sign-out clear, idle lock, retire passcode, stop selecting pin (Task 3); auto-stamp 5 write-sites, remove 5 inputs, lists show issuer (Task 4).
- **Modify** `material-issuance/index.html` — issuer-PIN unlock, session issuer, header, idle lock, auto-stamp `by_name`, remove `#i-by`, list shows issuer, retire passcode, stop selecting pin.
- **Modify** `preflight.html`, `admin/index.html`/`index.html` (home.js cache-bust), `scratchpad/nd-e2e/run-all.mjs`.
- **Create** `scratchpad/nd-e2e/issuer-access.mjs` — E2E built up across tasks.

---

### Task 1: Migration SQL

**Files:** Create `named-issuer-access.sql`

- [ ] **Step 1: Write the file** (verbatim):

```sql
-- Named issuer access — authorized ISSUERS unlock Tools + Material Issuance with their own PIN.
-- Additive + idempotent. Owner runs this in the Supabase SQL editor before deploy.
alter table public.employees add column if not exists is_issuer boolean not null default false;

-- Identify an ACTIVE issuer from a typed PIN. Returns {id,name} only (never the PIN); empty if no
-- active issuer has that PIN. security definer so it reads employees.pin regardless of caller.
create or replace function public.issuer_for_pin(pin_input text)
returns table(id uuid, name text)
language sql stable security definer as $$
  select e.id, e.name from public.employees e
  where e.is_issuer = true and e.pin is not null and e.pin = pin_input
  limit 1;
$$;

-- Seed the three initial issuers (exact roster names, owner-confirmed 2026-07-19).
update public.employees set is_issuer = true
where name in ('Jamaica L. Batucan', 'Alvin H. Operio', 'Ritchie Lawan');
```

- [ ] **Step 2: Hygiene** — the file uses `--` comments only (no `//`); `azfmpleswqixaslvcito` absent.
- [ ] **Step 3: Commit** — `git add named-issuer-access.sql && git commit -m "feat(issuer): SQL — is_issuer column, issuer_for_pin RPC, seed 3 issuers"`. (Owner runs it before deploy; no automated test — the E2E mocks `issuer_for_pin`.)

---

### Task 2: Admin — Issuers card + retire the passcode card (`home.js`)

**Files:** Modify `home.js` (getEmployees select ~:30; add Issuers card in the settings render; remove passcode card :1519-1526 + `saveSitePin` :739-743 + `sitePin` state :695)

**Interfaces:** Produces the `is_issuer` field on `emps`; uses existing `updateEmployee(id, fields)` and `loadEmps()`.

- [ ] **Step 1: Add `is_issuer` to the roster select** — in `getEmployees()` (~home.js:30) add `is_issuer` to the `.select('...')` column list.

- [ ] **Step 2: Add issuer handlers** near `saveEmp` (~:835):

```js
  const setIssuer = async (id, on) => {
    try { await updateEmployee(id, { is_issuer: on }); loadEmps(); }
    catch (e) { flash('Error: ' + e.message); }
  };
```

- [ ] **Step 3: Add the Issuers card** in the admin settings column, immediately BEFORE the employee card (`<div class="card">` at :1600). Use htm:

```js
        <div class="card">
          <div class="sectlabel" style="margin-top:0">Issuers (who can release tools & materials)</div>
          <p class="note" style="margin:0 0 12px">Authorized issuers unlock the Tools and Material Issuance pages with their OWN employee PIN, and every slip is stamped with their name. Add or remove issuers anytime — no code change.</p>
          ${(() => {
            const issuers = [...emps].filter(e => e.is_issuer).sort((a,b)=>(a.name||'').localeCompare(b.name||''));
            const nonIssuers = [...emps].filter(e => !e.is_issuer && e.pin).sort((a,b)=>(a.name||'').localeCompare(b.name||''));
            return html`
              <div style="margin-bottom:12px">
                ${issuers.length===0
                  ? html`<p class="note" style="margin:0">No issuers yet — add one below.</p>`
                  : issuers.map(e => html`<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px">
                      <div><strong>${e.name}</strong> <span class="mono" style="color:var(--ink-dim)">· ${e.code || '—'}</span></div>
                      <button class="btn" style="background:#fbf3e8;color:#b4540a;border-color:#f0d9bf" onClick=${() => setIssuer(e.id, false)}>Remove</button>
                    </div>`)}
              </div>
              <${Field} label="Add an issuer">
                <select value="" onChange=${e => { if (e.target.value) setIssuer(e.target.value, true); }}>
                  <option value="">Select an employee…</option>
                  ${nonIssuers.map(e => html`<option value=${e.id}>${e.name} (${e.code || '—'})</option>`)}
                </select>
              <//>
            `;
          })()}
        </div>
```
(Only employees WITH a PIN can be added — a PIN-less employee can't unlock anyway.)

- [ ] **Step 4: Retire the passcode card** — delete the "Issuance (site) passcode" card (:1519-1526), the `saveSitePin` handler (:739-743), and the `sitePin`/`setSitePin` state (:695). Grep home.js for `sitePin` and `issuance_pin` to confirm no dangling references remain.

- [ ] **Step 5: Validate** — `node --check home.js`. Bump the home.js cache-bust in `admin/index.html` and `index.html` (`home.js?v=…`) to `2026-07-19a`.

- [ ] **Step 6: Commit** — `git add home.js admin/index.html index.html && git commit -m "feat(admin): Issuers card (is_issuer) + retire the shared issuance passcode card"`.

---

### Task 3: Tools — issuer-PIN unlock, session issuer, idle lock, retire (`tools/index.html`)

**Files:** Modify `tools/index.html` (login markup :94-112; PIN fns :410-426; boot :440-451; employees select :512; stamp header/idle wiring)
**Test:** `scratchpad/nd-e2e/issuer-access.mjs` (tools unlock section)

**Interfaces:** Produces `sessionIssuer = {id, name} | null` (module var) used by Task 4's auto-stamp.

- [ ] **Step 1: Write the failing E2E** — create `scratchpad/nd-e2e/issuer-access.mjs`. Mock `**/rest/v1/**`: `rpc/issuer_for_pin` returns `[{id:'u-jam',name:'Jamaica L. Batucan'}]` when the POST body `pin_input==='654321'`, else `[]`; `sites`→two sites; `employees`→minimal (NO pin needed now); `settings`→null. Load `tools/index.html`, enter `654321` on the keypad → assert the home screen shows and the header shows "Issuer: Jamaica L. Batucan". Enter a non-issuer PIN `111111` → assert it stays on login with "Not an authorized issuer". Copy the launch/route pattern from `scratchpad/nd-e2e/tool-borrow-concurrency.mjs`; `serviceWorkers:'block'`.

- [ ] **Step 2: Run, confirm it fails** — `cd scratchpad/nd-e2e && node issuer-access.mjs` → FAIL (still checks issuance_pin).

- [ ] **Step 3: Login markup** (`:94-112`) — make it 6-digit and reword. Replace the 4 `pindot` divs (`:99`) with six (`pd0`…`pd5`); change "Enter PIN to continue" → "Enter your PIN"; **delete** the "Default PIN: 1111" line (`:110`); change `#pin-err` text to "Not an authorized issuer.".

- [ ] **Step 4: PIN fns + auth** (`:411-426`) — replace with:

```js
let pinVal='', sessionIssuer=null;
function pinTap(d){if(pinVal.length>=6)return;pinVal+=d;dots();if(pinVal.length===6)doLogin();}
function pinClear(){pinVal='';dots();}
function pinBack(){pinVal=pinVal.slice(0,-1);dots();}
function dots(){for(let i=0;i<6;i++){const e=document.getElementById('pd'+i);if(e)e.className='pindot'+(i<pinVal.length?' on':'');}}
async function doLogin(){
  const pin=pinVal; pinVal=''; dots();
  let issuer=null;
  try{ const{data,error}=await sb.rpc('issuer_for_pin',{pin_input:pin}); if(!error && data && data.length) issuer=data[0]; }catch(e){}
  if(!issuer){ document.getElementById('pin-err').style.display='block'; return; }
  document.getElementById('pin-err').style.display='none';
  sessionIssuer=issuer;
  await boot();
}
function doLogout(){ sessionIssuer=null; stopIdle(); showScreen('s-login'); }
```
Remove the now-dead `savedPin()` and `DEFAULT_PIN`/`PIN_KEY` constants (`:407`, `:416-419`).

- [ ] **Step 5: Header issuer display + idle lock** — in the `#s-home` header (`:116-120`), add an issuer element: `<div class="hdr-sub" id="hdr-issuer" style="font-weight:700"></div>`. In `boot()` (after `showScreen('s-home')`, :450) set it and arm idle:

```js
  document.getElementById('hdr-issuer').textContent = sessionIssuer ? 'Issuer: '+sessionIssuer.name : '';
  startIdle();
```
Add the idle helpers near the auth block:

```js
const IDLE_MS=10*60*1000; let _idleT=null;
function startIdle(){ resetIdle(); ['click','keydown','touchstart'].forEach(ev=>document.addEventListener(ev,resetIdle,true)); }
function stopIdle(){ if(_idleT)clearTimeout(_idleT); ['click','keydown','touchstart'].forEach(ev=>document.removeEventListener(ev,resetIdle,true)); }
function resetIdle(){ if(_idleT)clearTimeout(_idleT); _idleT=setTimeout(()=>{ doLogout(); }, IDLE_MS); }
```

- [ ] **Step 6: Stop selecting pin** — `:512` change `select('id,code,name,pin')` → `select('id,code,name')`.

- [ ] **Step 7: Validate + run** — `node scratchpad/validate.mjs .../tools/index.html` (node --check OK; `wpmc` present — tools embeds the URL at :405). `node issuer-access.mjs` → tools unlock section PASSES. Bump the tools stamp `v2026-07-19a` → `v2026-07-19b` (:118); note for Task 6.

- [ ] **Step 8: Commit** — `git add tools/index.html && git commit -m "feat(tools): issuer-PIN unlock + session issuer + idle auto-lock; retire shared passcode"`.

---

### Task 4: Tools — auto-stamp the 5 write-sites + remove inputs + lists show issuer

**Files:** Modify `tools/index.html` (borrow :642/:700; repair :849/:892; transfer :1075/:1120; ship-repaired :918/:931/:937; the `#bw-by`/`#rp-by`/`#tf-by`/`#rback-by` inputs; the list renders)
**Test:** `scratchpad/nd-e2e/issuer-access.mjs` (tools auto-stamp section)

**Interfaces:** Consumes `sessionIssuer` from Task 3.

- [ ] **Step 1: Failing E2E** — add a section: unlock as the issuer, drive a borrow to confirm, assert the POSTed `borrow_issuance` row's `issued_by === 'Jamaica L. Batucan'` (the session issuer), and that there is NO `#bw-by` input in the DOM. (Reuse the borrow-drive from `tool-borrow-concurrency.mjs`, but the issuer is now from the session, not typed.)

- [ ] **Step 2: Confirm red.**

- [ ] **Step 3: Swap each by-value to the session issuer and remove its input:**
  - Borrow: `:642` `const by=document.getElementById('bw-by').value.trim();` → `const by = sessionIssuer ? sessionIssuer.name : '';`. Remove the `if(!by)` validation. Remove the `#bw-by` label+input markup (:202-203); optionally add a static `<div class="lbl">Issued by: <span id="bw-by-disp"></span></div>` populated on form-open from `sessionIssuer.name`.
  - Repair: `:849` → `const by = sessionIssuer ? sessionIssuer.name : '';`; remove `#rp-by` (markup + the "Enter who is transmitting it" validation).
  - Transfer: `:1075` → same; remove `#tf-by` (markup + the ":1080 Enter who is sending the tools" validation).
  - Ship-repaired: `:918` → `const by = sessionIssuer ? sessionIssuer.name : '';`; remove `#rback-by` input; the label toggle at :915 stays but now labels a display, not an input.
  Every insert already reads `by` into its field (`issued_by`/`transmitted_by`/`sent_by`/`received_back_by`) — only the SOURCE of `by` changes.

- [ ] **Step 4: Lists show the issuer** — in the borrowed-now / records / repair / transfer list renders, add the stored by-field to each row (e.g. the borrow list at :769 already shows `slip_no` — append `· issued by ${r.issued_by||'—'}`). Do the same for repair (`transmitted_by`), transfer (`sent_by`).

- [ ] **Step 5: Validate + run** — `node scratchpad/validate.mjs .../tools/index.html` (node --check OK); `node issuer-access.mjs` → tools auto-stamp section PASSES (borrow/repair/transfer/ship-repaired all stamp the session issuer; no free-text inputs).

- [ ] **Step 6: Commit** — `git add tools/index.html && git commit -m "feat(tools): auto-stamp session issuer on every slip; remove free-text by inputs; lists show issuer"`.

---

### Task 5: Material Issuance — unlock, auto-stamp, idle lock, retire (`material-issuance/index.html`)

**Files:** Modify `material-issuance/index.html` (login :65-73; boot :259-261; doLogin :263-270; issue read :374 + insert :417; `#i-by` :108-109; employees select :277; list render; footer :72)
**Test:** `scratchpad/nd-e2e/issuer-access.mjs` (material section)

- [ ] **Step 1: Failing E2E** — add a material section: mock `rpc/issuer_for_pin` (as Task 3), load `material-issuance/index.html`, type `654321` into `#login-pin`, Sign in → home shows + header shows the issuer; then drive an issuance to confirm and assert the POSTed `issuances` row's `by_name === 'Jamaica L. Batucan'`; a non-issuer PIN is refused.

- [ ] **Step 2: Confirm red.**

- [ ] **Step 3: Auth** — replace `boot()` (`:259-261`, remove the issuance_pin load) and `doLogin` (`:263-270`):

```js
let sessionIssuer=null;
async function doLogin(){
  const pin=document.getElementById('login-pin').value.trim();
  document.getElementById('login-pin').value='';
  let issuer=null;
  try{ const{data,error}=await sb.rpc('issuer_for_pin',{pin_input:pin}); if(!error && data && data.length) issuer=data[0]; }catch(e){}
  if(!issuer){ toast('Not an authorized issuer'); return; }
  sessionIssuer=issuer;
  document.getElementById('hdr-issuer').textContent='Issuer: '+issuer.name;
  startIdle();
  showScreen('s-home');
  autoRequestCheck();
}
function logout(){ sessionIssuer=null; stopIdle(); showScreen('s-login'); }
```
Remove `let issuancePin='1111'` from `:251`. Add the SAME idle helpers as Task 3 Step 5 (IDLE_MS/startIdle/stopIdle/resetIdle). Add `<div class="tsub" id="hdr-issuer"></div>` to the `#s-home` header (`:78`). Delete the "Default: 1111" footer (`:72`). Change the login sub-label at `:69` to "Carmen · enter your PIN".

- [ ] **Step 4: Auto-stamp + remove input** — `:374` `const by=document.getElementById('i-by').value.trim();` → `const by = sessionIssuer ? sessionIssuer.name : '';`. Remove the `#i-by` label+input (`:108-109`). The insert at `:417` (`by_name:pending.by`) is unchanged. Ensure the issuance list render shows `by_name`.

- [ ] **Step 5: Stop selecting pin** — `:277` drop `pin` from the `employees` select.

- [ ] **Step 6: Validate + run** — `node scratchpad/validate.mjs .../material-issuance/index.html`; `node issuer-access.mjs` → material section PASSES. If the page has a version stamp, bump it; else add `v2026-07-19a` and note for Task 6.

- [ ] **Step 7: Commit** — `git add material-issuance/index.html && git commit -m "feat(material): issuer-PIN unlock + auto-stamp by_name + idle lock; retire shared passcode"`.

---

### Task 6: Tests wiring, stamps, preflight, regression

**Files:** Modify `scratchpad/nd-e2e/run-all.mjs`, `preflight.html`

- [ ] **Step 1: Wire the suite** — add `'issuer-access.mjs'` to `run-all.mjs` SUITES with a one-line description.

- [ ] **Step 2: Preflight** — bump `tools/index.html` in `EXPECT` to its new stamp (Task 3), and add `material-issuance/index.html` at its stamp (Task 5).

- [ ] **Step 3: Retirement guard (E2E)** — add an assertion to `issuer-access.mjs`: with `issuer_for_pin` mocked to always return `[]`, the OLD shared PIN (e.g. `1111`) does NOT unlock either page (proves the passcode is retired).

- [ ] **Step 4: Full regression + hygiene** — `node nd-e2e/run-all.mjs` from `scratchpad` → all suites green. Grep every changed repo file: `azfmpleswqixaslvcito` = 0.

- [ ] **Step 5: Commit** — `git add preflight.html && git commit -m "chore(issuer): preflight + regression wiring"`.

---

## Deploy (after all tasks green)

1. Owner runs `named-issuer-access.sql` (ALTER + RPC + seed) in Supabase; re-verify the column, function, and the three flagged issuers independently.
2. Owner localhost walkthrough: each of the three issuers unlocks Tools + Material with their own PIN; a non-issuer PIN is refused; a slip stamps the correct issuer; Sign out + re-unlock as a different issuer restamps; leave a page idle ~10 min → it locks; the old shared passcode no longer works; add/remove an issuer in the Admin Issuers card.
3. Push on explicit go; verify live stamps; tools/material tablets via `reset.html`.

## Notes

- `app.js` (orphaned `borrower-equipments/`) still reads `issuance_pin` — deliberately NOT retired (nothing links to it); leave as-is.
- Do not change `verify_pin` or the borrower/crew acceptance flow — only the ISSUER side.
- Both pages are classic inline-script apps (global functions), so the idle/auth code is inlined per page (small, independent apps) rather than a shared module.
