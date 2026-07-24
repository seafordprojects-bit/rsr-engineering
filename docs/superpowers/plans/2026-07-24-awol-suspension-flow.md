# AWOL Suspension Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing consecutive-absence detection into a full AWOL flow — a blocking PIN-entry modal, an auto-generated printable A4 letter, a dedicated Telegram AWOL group as a running log, with suspension state shared across kiosks via Supabase.

**Architecture:** A new `employee_suspensions` table is the source of truth; each kiosk keeps its local `suspendedEmployees` object as a poller-refreshed read-cache. Two atomic security-definer RPCs (`awol_set_suspended`, `awol_reinstate`) dedup alerts/closes across kiosks. All new UI/notification code lives in `kiosk/index.html`; the letter is a standalone static page.

**Tech Stack:** Vanilla JS + Preact/htm (no build), Supabase PostgREST + `supabase-js` (`sbClient`), Telegram Bot API, Playwright harness (`tests/kiosk-stress`).

## Global Constraints

- **No build step / no npm / no framework** — vanilla JS + CDN only.
- **Supabase project `wpmcbjrisuyjvobvzaus` ONLY**; `azfmpleswqixaslvcito` must never appear.
- **SQL uses `--` comments; htm/HTML template literals use literal `&`, never `&amp;`.**
- **Complete files only** when handing to the owner; **validate before shipping**: `node --check` the largest inline `<script>` + hygiene grep (`wpmcbjrisuyjvobvzaus` present, `azfmpleswqixaslvcito` absent).
- **Read the CURRENT live file before editing** (kiosk/index.html is large and has been edited across sessions).
- **Worker-facing + punch-blocking → localhost walkthrough gate before any push to `main`.** This plan builds + validates only; the owner runs the walkthrough and gives the explicit "push".
- **Payroll is untouched** by this feature.
- Kiosk version stamp lives in the header (currently `v2026-07-24a`); this build bumps to **`v2026-07-24b`**. Bump `preflight.html` EXPECT in lockstep.
- Owner-locked behavior: pending leave = **HOLD + flag**; alert routing = **AWOL group only** (mgr-DM fallback while `tg_awol_group` unset); reinstatement UI unchanged; suspension state **DB-shared**.

---

## File Structure

- **Create `awol-suspensions.sql`** (repo root) — `employee_suspensions` table, `awol_set_suspended` + `awol_reinstate` RPCs, `tg_awol_group` settings key. Owner-applied; the harness mock mirrors it.
- **Create `awol-letter.html`** (repo root) — standalone A4 printable letter, filled from URL params.
- **Modify `kiosk/index.html`** — version stamp; `tgAwolGroup` config; `employee_suspensions` read (`loadSuspensionsFromCloud`) + poller + boot cutover; PIN-entry modal; `checkAllAbsences` Hold+flag + `awol_set_suspended`; `sendAwolAlert` / `sendAwolPendingFlag`; `reinstateEmployee` → RPC + closing message across all 3 paths.
- **Modify `preflight.html`** — EXPECT `kiosk/index.html` → `v2026-07-24b`; add `awol-letter.html` stamp.
- **Modify `tests/kiosk-stress/kiosk-stress.mjs`** — shared suspensions store, RPC + `employee_suspensions` + tg-settings mocks, Telegram capture, and new scenarios G1–G8.

---

## Task 1: SQL migration — shared table + dedup RPCs + AWOL group key

**Files:**
- Create: `awol-suspensions.sql`

**Interfaces:**
- Produces (called by the kiosk via `sbClient.rpc` / `.from`): `awol_set_suspended(p_code text, p_reason text, p_dates jsonb, p_on text) → boolean` (true only when newly activated); `awol_reinstate(p_code text, p_by text, p_on text) → jsonb` (`{newly, awol_group_msg_id, awol_group_chat}`); table `public.employee_suspensions`; settings key `tg_awol_group`.

- [ ] **Step 1: Write the migration file**

Create `awol-suspensions.sql`:

```sql
-- ═══════════════════════════════════════════════════════════════════════════════
--  AWOL suspension flow — shared state + dedup RPCs + dedicated group key
--  Additive + idempotent. RLS-disabled project convention (anon read/write via PostgREST).
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── STEP 0 — CENSUS (read-only; run first) ────────────────────────────────────
select to_regclass('public.employee_suspensions') as table_exists;             -- expect NULL first run
select key, value from public.settings where key = 'tg_awol_group';            -- expect 0 rows first run

-- ── STEP 1 — shared table (source of truth; one row per employee) ─────────────
create table if not exists public.employee_suspensions (
  employee_code     text primary key,
  active            boolean not null default true,
  reason            text,
  suspended_on      text,
  absent_dates      jsonb,
  awol_group_msg_id text,
  awol_group_chat   text,
  reinstated_by     text,
  reinstated_on     text,
  updated_at        timestamptz not null default now()
);
grant select, insert, update on public.employee_suspensions to anon, authenticated;

-- ── STEP 2 — atomic dedup RPCs (security definer) ─────────────────────────────
-- Returns TRUE only when THIS call newly activates the suspension → exactly one alert
-- even if two kiosks detect the same AWOL in the same run.
create or replace function public.awol_set_suspended(p_code text, p_reason text, p_dates jsonb, p_on text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_was_active boolean;
begin
  select active into v_was_active from employee_suspensions where employee_code = p_code;
  if v_was_active is true then
    return false;
  end if;
  insert into employee_suspensions(employee_code, active, reason, suspended_on, absent_dates, updated_at)
    values (p_code, true, p_reason, p_on, p_dates, now())
    on conflict (employee_code) do update
      set active = true, reason = excluded.reason, suspended_on = excluded.suspended_on,
          absent_dates = excluded.absent_dates,
          awol_group_msg_id = null, awol_group_chat = null,
          reinstated_by = null, reinstated_on = null, updated_at = now();
  return true;
end $$;
grant execute on function public.awol_set_suspended(text, text, jsonb, text) to anon, authenticated;

-- Flips an active row to inactive; returns the stored group msg id so ANY kiosk can edit
-- the original alert to RESOLVED. {newly:false} when nothing was active (dedup).
create or replace function public.awol_reinstate(p_code text, p_by text, p_on text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_active boolean; v_msg text; v_chat text;
begin
  select active, awol_group_msg_id, awol_group_chat into v_active, v_msg, v_chat
    from employee_suspensions where employee_code = p_code;
  if v_active is not true then
    return jsonb_build_object('newly', false);
  end if;
  update employee_suspensions
     set active = false, reinstated_by = p_by, reinstated_on = p_on, updated_at = now()
   where employee_code = p_code;
  return jsonb_build_object('newly', true, 'awol_group_msg_id', v_msg, 'awol_group_chat', v_chat);
end $$;
grant execute on function public.awol_reinstate(text, text, text) to anon, authenticated;

-- ── STEP 3 — dedicated AWOL group settings key (value set by owner after chat-ID capture) ──
insert into public.settings(key, value)
  select 'tg_awol_group', ''
  where not exists (select 1 from public.settings where key = 'tg_awol_group');

-- ── STEP 4 — RE-QUERY / verify ────────────────────────────────────────────────
select * from public.employee_suspensions order by updated_at desc limit 20;
select key, value from public.settings where key = 'tg_awol_group';
-- smoke (optional): select public.awol_set_suspended('TEST999','smoke','["2026-07-20"]'::jsonb,'07/24/2026');
--                    select public.awol_reinstate('TEST999','tester','07/24/2026');
--                    delete from public.employee_suspensions where employee_code='TEST999';
```

- [ ] **Step 2: Hygiene grep the file**

Run: `grep -c azfmpleswqixaslvcito awol-suspensions.sql` → Expected: `0`.
Run: `grep -c '//' awol-suspensions.sql` → Expected: `0` (SQL uses `--`, never `//`).

- [ ] **Step 3: Commit**

```bash
git add awol-suspensions.sql
git commit -m "feat(db): AWOL shared-suspension table + dedup RPCs + tg_awol_group key"
```

> **Note:** This SQL is applied to Supabase by the owner (STEP 0 census first, per repo convention). No automated unit test — the harness mock in Task 3 mirrors this contract exactly so the kiosk code is exercised against the same shapes.

---

## Task 2: Standalone printable AWOL letter page

**Files:**
- Create: `awol-letter.html`

**Interfaces:**
- Consumes: URL params `name, code, yard, dates` (comma-separated ISO or MM/DD/YYYY), `pdate`.
- Produces: a self-contained A4 print page; no JS exports.

- [ ] **Step 1: Create the letter page** (this is the owner-approved layout; the top bar is screen-only)

Create `awol-letter.html` with exactly this content:

```html
<!doctype html>
<html lang="ceb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AWOL Letter — RSR Engineering</title>
<!-- awol-letter v2026-07-24b -->
<style>
  :root{ --ink:#1a1a1a; --muted:#555; --line:#333; }
  *{ box-sizing:border-box; }
  html,body{ margin:0; padding:0; background:#e9e9e6; color:var(--ink); font-family:'Times New Roman', Georgia, serif; }
  .screen-bar{ position:sticky; top:0; display:flex; gap:10px; align-items:center; justify-content:center; padding:10px; background:#2b2b2b; color:#fff; font-family:-apple-system,'Segoe UI',sans-serif; font-size:13px; z-index:10; }
  .screen-bar button{ background:#378ADD; color:#fff; border:none; border-radius:8px; padding:9px 18px; font-size:14px; font-weight:600; cursor:pointer; }
  .sheet{ width:210mm; min-height:297mm; margin:16px auto; background:#fff; padding:22mm 20mm; box-shadow:0 2px 14px rgba(0,0,0,.2); }
  .letterhead{ text-align:center; border-bottom:2.5px solid var(--line); padding-bottom:10px; margin-bottom:6px; }
  .company{ font-size:26px; font-weight:700; letter-spacing:2px; }
  .yard{ font-size:14px; color:var(--muted); margin-top:2px; letter-spacing:1px; }
  .title{ text-align:center; margin:22px 0 4px; }
  .title .ceb{ font-size:17px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; }
  .title .en{ font-size:12.5px; color:var(--muted); font-style:italic; margin-top:2px; }
  .meta{ margin:20px 0 4px; font-size:14.5px; line-height:1.9; }
  p{ font-size:14.5px; line-height:1.8; text-align:justify; margin:12px 0; }
  .dates{ margin:10px 0 14px; padding-left:8px; }
  .dates li{ font-size:15px; font-weight:700; line-height:2.0; list-style:none; }
  .dates li::before{ content:"•  "; }
  .section-label{ font-weight:700; font-size:14px; margin-top:20px; letter-spacing:.3px; }
  .hand{ margin-top:8px; }
  .hand .rule{ border-bottom:1px solid #444; height:2.3rem; margin-top:.7rem; }
  .reminder{ margin-top:18px; font-size:13px; font-style:italic; color:#333; border-left:3px solid #999; padding:6px 0 6px 12px; }
  .sigs{ margin-top:34px; }
  .sig{ margin-top:40px; }
  .sig .sigline{ border-bottom:1px solid #333; height:1px; width:75%; }
  .sig .siglabel{ font-size:12.5px; color:#333; margin-top:5px; }
  @page{ size:A4; margin:16mm; }
  @media print{
    html,body{ background:#fff; }
    .screen-bar{ display:none; }
    .sheet{ width:auto; min-height:auto; margin:0; padding:0; box-shadow:none; }
  }
</style>
</head>
<body>
  <div class="screen-bar">
    <span>Ang mubo nga bar sa ibabaw dili mo-print. I-press ang Print, unya pili og printer o "Save as PDF".</span>
    <button onclick="window.print()">🖨 Print / Save PDF</button>
  </div>

  <div class="sheet">
    <div class="letterhead">
      <div class="company">RSR ENGINEERING</div>
      <div class="yard" id="f-yard">Carmen</div>
    </div>
    <div class="title">
      <div class="ceb">Pahibalo sa Pagpasabot ug Pagbalik sa Trabaho</div>
      <div class="en">(Notice to Explain / Return-to-Work Order)</div>
    </div>
    <div class="meta">
      Petsa: <b id="f-pdate">Hulyo 24, 2026</b><br>
      Para kang: <b id="f-name">Juan Dela Cruz</b> — <b id="f-code">RSR 0042</b>
    </div>
    <p>Sumala sa atong rekord sa attendance, wala ka nakasulod sa trabaho sulod sa mosunod nga mga petsa:</p>
    <ul class="dates" id="f-dates">
      <li>Lunes, Hulyo 20, 2026</li><li>Martes, Hulyo 21, 2026</li><li>Miyerkules, Hulyo 22, 2026</li>
    </ul>
    <p>nga walay gi-file o approved nga leave. Tungod niini, ang imong account sa attendance system temporaryong gi-suspend sumala sa polisiya sa kompanya bahin sa AWOL (Absent Without Official Leave — 3 ka adlaw nga sunod-sunod).</p>
    <p>Gihangyo ka nga isulat sa ubos ang imong pagpasabot nganong wala ka nakasulod sa trabaho sa maong mga petsa:</p>
    <div class="section-label">PAGPASABOT SA EMPLEYADO:</div>
    <div class="hand"><div class="rule"></div><div class="rule"></div><div class="rule"></div><div class="rule"></div><div class="rule"></div></div>
    <p>Human nimo mapil-apan kini nga porma, isumite kini sa admin/opisina. Ang admin maoy mo-desisyon sa pag-reinstate sa imong account aron ka maka-punch pag-usab.</p>
    <div class="reminder">Pahinumdom: Ang pagbalik-balik nga AWOL mahimong hinungdan sa dugang nga disciplinary action sumala sa polisiya sa kompanya.</div>
    <div class="sigs">
      <div class="sig"><div class="sigline"></div><div class="siglabel">Pirma sa Empleyado / Petsa</div></div>
      <div class="sig"><div class="sigline"></div><div class="siglabel">Pirma sa Admin / Petsa sa Pag-reinstate</div></div>
      <div class="sig"><div class="sigline"></div><div class="siglabel">Gi-prepare ni (Coordinator) / Petsa</div></div>
    </div>
  </div>

<script>
(function(){
  const MON=['Enero','Pebrero','Marso','Abril','Mayo','Hunyo','Hulyo','Agosto','Septyembre','Oktubre','Nobyembre','Disyembre'];
  const DOW=['Dominggo','Lunes','Martes','Miyerkules','Huwebes','Biyernes','Sabado'];
  function toISO(s){ s=String(s||'').trim();
    if(/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
    const m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if(m) return m[3]+'-'+m[1].padStart(2,'0')+'-'+m[2].padStart(2,'0');
    return s; }
  function pretty(iso){ const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(toISO(iso)); if(!m) return iso;
    const d=new Date(+m[1],+m[2]-1,+m[3]);
    return DOW[d.getDay()]+', '+MON[+m[2]-1]+' '+(+m[3])+', '+m[1]; }
  const q=new URLSearchParams(location.search), g=k=>((q.get(k)||'').trim());
  const set=(id,v)=>{ if(v) document.getElementById(id).textContent=v; };
  set('f-yard', g('yard')); set('f-name', g('name')); set('f-code', g('code'));
  const pd=g('pdate'); if(pd) set('f-pdate', pretty(pd));
  const ds=g('dates');
  if(ds){ const list=ds.split(/[,|]/).map(s=>s.trim()).filter(Boolean);
    if(list.length) document.getElementById('f-dates').innerHTML=list.map(x=>'<li>'+pretty(x)+'</li>').join(''); }
})();
</script>
</body>
</html>
```

- [ ] **Step 2: Validate the inline script + hygiene**

Run:
```bash
node -e 'const fs=require("fs");const h=fs.readFileSync("awol-letter.html","utf8");const m=[...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(x=>x[1]).sort((a,b)=>b.length-a.length)[0];fs.writeFileSync(process.env.TEMP+"/awol_letter.mjs",m);'
node --check "$TEMP/awol_letter.mjs" && echo OK
grep -c azfmpleswqixaslvcito awol-letter.html
```
Expected: `OK`, then `0`.

- [ ] **Step 3: Visual check** — open `awol-letter.html?name=Test%20Worker&code=RSR%200099&yard=Mandaue&dates=2026-07-20,2026-07-21,2026-07-22&pdate=2026-07-24` in a browser; confirm the yard/name/code/dates fill and the dark bar disappears in the Print preview.

- [ ] **Step 4: Commit**

```bash
git add awol-letter.html
git commit -m "feat(awol): standalone A4 printable AWOL letter page"
```

---

## Task 3: Extend the stress harness (shared DB + RPC + tg settings + Telegram capture)

**Files:**
- Modify: `tests/kiosk-stress/kiosk-stress.mjs` (mock block ~57–168; add helpers near the reporting plumbing ~199)

**Interfaces:**
- Produces (for later scenario tasks): `mock.suspensions` (shared store, keyed by `employee_code`), `mock.telegram` (captured sends), `mock.tgConfigured` (bool), `mock.awolGroupId` (string); mocked endpoints `/rest/v1/rpc/awol_set_suspended`, `/rest/v1/rpc/awol_reinstate`, GET/PATCH `/rest/v1/employee_suspensions`, GET `/rest/v1/settings` (tg keys when configured). Helper `enterPin(code)`.

- [ ] **Step 1: Add the shared stores to the `mock` object** (in the `const mock = { … }` block ~57)

Add these fields:

```js
  suspensions: {},     // employee_code → row {employee_code,active,reason,suspended_on,absent_dates,awol_group_msg_id,awol_group_chat}
  telegram: [],        // captured Telegram sends: {method, chat_id, text, hasButtons}
  tgConfigured: false, // when true, /settings returns a live tg_token + tg_awol_group
  awolGroupId: '',     // the mocked AWOL group chat id
  tgMsgSeq: 1000,      // incrementing message_id source
```

Also extend `resetCapture`:

```js
const resetCapture = () => { mock.writes = []; mock.telegram = []; };
```

- [ ] **Step 2: Add the AWOL Supabase endpoints** — inside the `if (host === FORBIDDEN_HOST) { … }` block, BEFORE the final `if (method === 'GET') return json(200, []);` fallback:

```js
      // AWOL: shared suspension table (read + msg-id patch)
      if (p.endsWith('/rest/v1/employee_suspensions')) {
        if (method === 'GET') {
          const active = Object.values(mock.suspensions).filter(r => r.active);
          return json(200, active);
        }
        if (method === 'PATCH') {
          let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch {}
          const codeMatch = /employee_code=eq\.([^&]+)/.exec(new URL(url).search || '');
          const code = codeMatch ? decodeURIComponent(codeMatch[1]) : null;
          if (code && mock.suspensions[code] && body) Object.assign(mock.suspensions[code], body);
          return json(200, code && mock.suspensions[code] ? [mock.suspensions[code]] : []);
        }
      }
      // AWOL: dedup RPCs
      if (p.endsWith('/rest/v1/rpc/awol_set_suspended')) {
        let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch {}
        const ex = mock.suspensions[b.p_code];
        if (ex && ex.active) return json(200, false);
        mock.suspensions[b.p_code] = { employee_code: b.p_code, active: true, reason: b.p_reason,
          suspended_on: b.p_on, absent_dates: b.p_dates, awol_group_msg_id: null, awol_group_chat: null };
        return json(200, true);
      }
      if (p.endsWith('/rest/v1/rpc/awol_reinstate')) {
        let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch {}
        const r = mock.suspensions[b.p_code];
        if (!r || !r.active) return json(200, { newly: false });
        r.active = false; r.reinstated_by = b.p_by; r.reinstated_on = b.p_on;
        return json(200, { newly: true, awol_group_msg_id: r.awol_group_msg_id, awol_group_chat: r.awol_group_chat });
      }
      // settings: tg config only when a scenario opts in (keeps existing scenarios' settings=[] behaviour)
      if (p.endsWith('/rest/v1/settings') && method === 'GET') {
        if (!mock.tgConfigured) return json(200, []);
        return json(200, [
          { key: 'tg_token', value: 'TESTTOKEN0000000000000000000000000000' },
          { key: 'tg_awol_group', value: mock.awolGroupId || '' },
          { key: 'mgr_ids', value: '111,222' },
        ]);
      }
```

- [ ] **Step 3: Capture Telegram sends** — replace the existing `api.telegram.org` stub (~168) with:

```js
    if (host === 'api.telegram.org') {
      const p = new URL(url).pathname;
      let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch {}
      if (p.endsWith('/sendMessage')) {
        mock.telegram.push({ method: 'sendMessage', chat_id: String(b.chat_id), text: String(b.text || ''), hasButtons: !!b.reply_markup });
        return json(200, { ok: true, result: { message_id: ++mock.tgMsgSeq } });
      }
      if (p.endsWith('/editMessageText')) {
        mock.telegram.push({ method: 'editMessageText', chat_id: String(b.chat_id), text: String(b.text || ''), hasButtons: false });
        return json(200, { ok: true, result: { message_id: b.message_id } });
      }
      return json(200, { ok: true, result: {} });
    }
```

- [ ] **Step 4: Add an `enterPin` helper** near the assertion plumbing (~199, after `getRec` / `sends`):

```js
// Drive the REAL keypad so the kp() PIN-entry hooks (modal, preview) run.
async function enterPin(code) {
  const pin = pinOf(code);
  await page.evaluate((pn) => { kpClr(); for (const d of pn) kp(d); }, pin);
}
// Read whether the Bisaya modal is showing + its text.
async function bisayaState() {
  return await page.evaluate(() => ({
    show: document.getElementById('bisaya-modal').classList.contains('show'),
    text: (document.getElementById('bisaya-text') || {}).textContent || '',
  }));
}
```

- [ ] **Step 5: Run the full harness — verify NO regression**

Run: `node tests/kiosk-stress/kiosk-stress.mjs`
Expected: still `41/41 checks passed`, `abandoned ref azfmpleswqixaslvcito contacts: 0` (mock changes are inert until scenarios opt in via `mock.tgConfigured`).

- [ ] **Step 6: Commit**

```bash
git add tests/kiosk-stress/kiosk-stress.mjs
git commit -m "test(harness): AWOL shared-suspension DB + RPC + Telegram-capture mocks"
```

---

## Task 4: Kiosk — AWOL group config + version stamp

**Files:**
- Modify: `kiosk/index.html` — header stamp (~238); tg vars (~1126); `loadTgFromCloud` (~5042–5074)

**Interfaces:**
- Produces: global `tgAwolGroup` (string); `awolTarget()` → the group id or the mgr-DM fallback.

- [ ] **Step 1: Bump the version stamp**

Find the header stamp `v2026-07-24a` (~line 238) and change it to `v2026-07-24b`.

- [ ] **Step 2: Add the `tgAwolGroup` variable** — at ~line 1126 change:

```js
let tgToken='',tgGroup='',tgPosGroup='',tgPhotoGroup='',tgBackupGroup='',mgrIds=[];
```
to:
```js
let tgToken='',tgGroup='',tgPosGroup='',tgPhotoGroup='',tgBackupGroup='',tgAwolGroup='',mgrIds=[];
```

- [ ] **Step 3: Load the key in `loadTgFromCloud`** — three edits inside the function (~5044–5070):

(a) keys list:
```js
  const keys=['tg_token','tg_group','tg_backup_group','tg_pos_group','tg_photo_group','tg_awol_group','mgr_ids'];
```
(b) after `tgPhotoGroup=(map.tg_photo_group||'').trim();` add:
```js
      tgAwolGroup=(map.tg_awol_group||'').trim();
```
(c) include it in the cache write and the offline restore — change the cache line to:
```js
      try{localStorage.setItem('rsr_tg',JSON.stringify({tgToken,tgGroup,tgBackupGroup,tgPosGroup,tgPhotoGroup,tgAwolGroup,mgrIds}));}catch(e){}
```
and in the offline-cache `if(c&&c.tgToken){…}` block add:
```js
      tgAwolGroup=c.tgAwolGroup||'';
```

- [ ] **Step 4: Add the fallback helper** — immediately after `loadTgFromCloud` (~5075):

```js
// AWOL alerts go to the dedicated group; fall back to manager DMs while the group id is unset.
function awolTarget(){ return tgAwolGroup || (mgrIds && mgrIds[0]) || tgGroup || ''; }
```

- [ ] **Step 5: Write the failing scenario** — append to the scenario list in `tests/kiosk-stress/kiosk-stress.mjs`:

```js
await scenario('G0 · AWOL group id loads from settings', manila(2026,7,24,8,0), async () => {
  mock.tgConfigured = true; mock.awolGroupId = '-1001112223334';
  await page.evaluate(() => loadTgFromCloud());
  const g = await page.evaluate(() => tgAwolGroup);
  report('G0 · tg_awol_group loaded', g === '-1001112223334', `tgAwolGroup=${g}`);
});
```

- [ ] **Step 6: Run it — expect FAIL, then PASS**

Run: `node tests/kiosk-stress/kiosk-stress.mjs`
Expected before Step 1–4 applied: `G0` FAILs (`tgAwolGroup` undefined). After: `G0` PASSes and total is `42/42`.

- [ ] **Step 7: Commit**

```bash
git add kiosk/index.html tests/kiosk-stress/kiosk-stress.mjs
git commit -m "feat(kiosk): load tg_awol_group + awolTarget fallback (v2026-07-24b)"
```

---

## Task 5: Kiosk — DB-shared suspension read (cache + poller + boot cutover)

**Files:**
- Modify: `kiosk/index.html` — add functions near `reinstateEmployee` (~2272); boot wiring near `loadTgFromCloud()` call (~5076); `loadData` (~4351)

**Interfaces:**
- Consumes: `awol_set_suspended` (Task 1/3).
- Produces: `loadSuspensionsFromCloud()` (async → bool); `awolCutover()` (async); global `awolPending{}`; `saveAwolPending()`.

- [ ] **Step 1: Add the loader + cutover + pending map** — insert after `reinstateEmployee` (~2272):

```js
// ── AWOL: DB-shared suspension state (employee_suspensions is source of truth) ──
let awolPending={}; // {code:true} — one-time "pending leave, please decide" flag bookkeeping (local)
function saveAwolPending(){ try{localStorage.setItem('rsr_awol_pending',JSON.stringify(awolPending));}catch(e){} }
function awolISO(s){ s=String(s||'').trim();
  if(/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
  const m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m?m[3]+'-'+m[1].padStart(2,'0')+'-'+m[2].padStart(2,'0'):s; }
async function loadSuspensionsFromCloud(){
  try{
    const { data, error } = await sbClient.from('employee_suspensions').select('*').eq('active',true);
    if(error) throw error;
    const next={};
    (data||[]).forEach(r=>{ next[r.employee_code]={ reason:r.reason||'', suspendedOn:r.suspended_on||'',
      absentDates:Array.isArray(r.absent_dates)?r.absent_dates:[], awolMsgId:r.awol_group_msg_id||'', awolChat:r.awol_group_chat||'' }; });
    suspendedEmployees=next;
    try{localStorage.setItem('rsr_suspended',JSON.stringify(suspendedEmployees));}catch(e){}
    if(typeof renderRoster==='function')renderRoster();
    return true;
  }catch(e){ console.warn('loadSuspensionsFromCloud (using cache):',e&&e.message); return false; }
}
// One-time cutover: import any pre-existing local suspensions into the shared table (no alert re-fire).
async function awolCutover(){
  try{
    if(localStorage.getItem('rsr_awol_cutover')==='done') return;
    const local=JSON.parse(localStorage.getItem('rsr_suspended')||'{}')||{};
    for(const code of Object.keys(local)){ const e=local[code]; if(!e)continue;
      try{ await sbClient.rpc('awol_set_suspended',{p_code:code,p_reason:e.reason||'migrated',p_dates:(e.absentDates||[]).map(awolISO),p_on:e.suspendedOn||todayKey()}); }catch(_){}
    }
    localStorage.setItem('rsr_awol_cutover','done');
  }catch(e){}
}
```

- [ ] **Step 2: Load the pending map in `loadData`** — near the `rsr_suspended` load (~4351) add:

```js
    const ap=localStorage.getItem('rsr_awol_pending'); if(ap){try{awolPending=JSON.parse(ap)||{};}catch(e){awolPending={};}}
```

- [ ] **Step 3: Wire boot + poller** — after `loadTgFromCloud();` (~5076) add:

```js
awolCutover().then(loadSuspensionsFromCloud);
setInterval(loadSuspensionsFromCloud, 45000);
```

- [ ] **Step 4: Write the failing scenario** — append:

```js
await scenario('G-load · poll surfaces a shared suspension', manila(2026,7,24,8,0), async () => {
  mock.suspensions['RSR0100'] = { employee_code:'RSR0100', active:true, reason:'x', suspended_on:'07/24/2026',
    absent_dates:['2026-07-21','2026-07-22','2026-07-23'] };
  await page.evaluate(() => loadSuspensionsFromCloud());
  const has = await page.evaluate(() => !!suspendedEmployees['RSR0100']);
  report('G-load · shared suspension cached', has, `cached=${has}`);
});
```

- [ ] **Step 5: Run — FAIL then PASS**

Run: `node tests/kiosk-stress/kiosk-stress.mjs` → `G-load` FAILs before Step 1, PASSes after. Total `43/43`.

- [ ] **Step 6: Commit**

```bash
git add kiosk/index.html tests/kiosk-stress/kiosk-stress.mjs
git commit -m "feat(kiosk): DB-shared suspension read + poller + boot cutover"
```

---

## Task 6: Kiosk — PART 1 blocking PIN-entry modal

**Files:**
- Modify: `kiosk/index.html` — `kp()` identification hook (~2046); `#bisaya-text` CSS (find the modal's style rule)

**Interfaces:**
- Consumes: `suspendedEmployees` cache (Task 5), `showBisayaModal` (~1004).

- [ ] **Step 1: Ensure multi-line modal text renders** — find the `#bisaya-text` CSS rule (search `bisaya-text` in the `<style>` block) and add `white-space:pre-line;` to it. If no dedicated rule exists, add one in the style block:

```css
#bisaya-text{ white-space:pre-line; }
```

- [ ] **Step 2: Add the block at the TOP of the identified-employee branch** — in `kp()` (~2046), immediately after `showEmpPreview(emp);clearMsg();` and BEFORE the `const _r=getRec(emp.code);` line, insert:

```js
      // (2026-07-24) AWOL: a suspended worker is blocked at PIN entry on EVERY kiosk (DB-shared state).
      // Fully blocks — a 3+-day-absent worker has no open shift to Time Out. Dismiss → kpClr clears PIN.
      if(suspendedEmployees[emp.code]){
        showBisayaModal('GI-SUSPEND ANG IMONG ACCOUNT\n\nAbsent ka og 3+ ka adlaw nga sunod-sunod nga walay approved nga leave.\n\nAdto sa admin/opisina aron ma-reinstate una ka maka-punch.');
        loadSuspensionsFromCloud(); // opportunistic refresh so the next worker's state is fresh
        return;
      }
```

- [ ] **Step 3: Write the failing scenario** — append:

```js
await scenario('G1 · suspended PIN → blocking modal, no punch', manila(2026,7,24,8,0), async () => {
  mock.suspensions['RSR0100'] = { employee_code:'RSR0100', active:true, reason:'AWOL',
    suspended_on:'07/24/2026', absent_dates:['2026-07-21','2026-07-22','2026-07-23'] };
  await page.evaluate(() => loadSuspensionsFromCloud());
  await enterPin('RSR0100');
  const b = await bisayaState();
  const rec = await getRec('RSR0100');
  const pass = b.show && /GI-SUSPEND/.test(b.text) && (!rec || !rec.punches.timein);
  report('G1 · suspended PIN blocking modal', pass, `modal=${b.show} text="${b.text.slice(0,22)}" timein=${rec?.punches.timein||'(none)'}`);
});
```

- [ ] **Step 4: Run — FAIL then PASS**

Run: `node tests/kiosk-stress/kiosk-stress.mjs` → `G1` FAILs before Step 2, PASSes after. Total `44/44`.

- [ ] **Step 5: Commit**

```bash
git add kiosk/index.html tests/kiosk-stress/kiosk-stress.mjs
git commit -m "feat(kiosk): PART 1 blocking AWOL modal at PIN entry"
```

---

## Task 7: Kiosk — detection Hold+flag + dedup suspend + AWOL alert with letter

**Files:**
- Modify: `kiosk/index.html` — replace `checkAllAbsences` (~2232–2250); add `collectAbsentDates`, `sendAwolAlert`, `sendAwolPendingFlag` (near ~2251, replacing the old `sendAbsenceSuspensionAlert` usage)

**Interfaces:**
- Consumes: `awol_set_suspended` (Task 1/3), `awolISO`, `awolTarget`, `tgSendWithButtons`, `tgSendText`, `siteNorm`, `bisayaDate`.
- Produces: rebuilt `checkAllAbsences()` (async); `sendAwolAlert(emp, isoDates)`; `sendAwolPendingFlag(emp, isoDates)`.

- [ ] **Step 1: Replace `checkAllAbsences` and the old alert** — replace lines ~2232–2266 (`checkAllAbsences` through the end of `sendAbsenceSuspensionAlert`) with:

```js
// Collect the consecutive absent run (most-recent-first), as MM/DD/YYYY keys.
function collectAbsentDates(empCode){
  const out=[];
  for(let i=1;i<=7;i++){ const d=dateKeyOffset(-i); if(isAbsentOnDate(empCode,d))out.push(d); else break; }
  return out;
}
async function checkAllAbsences(){
  const today=todayKey();
  for(const emp of employees){
    if(suspendedEmployees[emp.code])continue;
    if(onLeaveToday(emp.code))continue;
    const dates=collectAbsentDates(emp.code);
    if(dates.length<3){ if(awolPending[emp.code]){awolPending[emp.code]=false;saveAwolPending();} continue; }
    const iso=dates.map(awolISO);
    // HOLD + flag if a PENDING leave overlaps any absent date (owner rule).
    const hasPending=leaveRequests.some(r=>r.code===emp.code&&r.status==='Pending'&&iso.some(t=>awolISO(r.startDate)<=t&&awolISO(r.endDate)>=t));
    if(hasPending){
      if(!awolPending[emp.code]){ awolPending[emp.code]=true; saveAwolPending(); sendAwolPendingFlag(emp,iso); }
      continue;
    }
    if(awolPending[emp.code]){ awolPending[emp.code]=false; saveAwolPending(); }
    // SUSPEND with cross-kiosk dedup — only the device that newly activates alerts.
    let newly=true;
    try{ const {data}=await sbClient.rpc('awol_set_suspended',{p_code:emp.code,p_reason:`Absent ${dates.length} consecutive days without approved leave`,p_dates:iso,p_on:today}); newly=(data===true); }
    catch(e){ newly=true; } // offline: mark locally so THIS kiosk blocks; a peer will have alerted
    suspendedEmployees[emp.code]={reason:`Absent ${dates.length} consecutive days`,suspendedOn:today,absentDates:iso};
    saveData();
    if(newly) await sendAwolAlert(emp,iso);
  }
  loadSuspensionsFromCloud();
}
// PART 2/3 — AWOL alert to the dedicated group (or mgr-DM fallback) with the printable letter link.
async function sendAwolAlert(emp,iso){
  logNotif(`🚨 ${emp.name} AWOL-suspended`,'late-n',true);
  if(!tgToken||tgToken.length<20)return;
  const yard=siteNorm(emp.homeSite||activeSite||'');
  const base=location.origin+location.pathname.replace(/\/kiosk\/index\.html.*$/,'');
  const letter=base+'/awol-letter.html?name='+encodeURIComponent(emp.name)+'&code='+encodeURIComponent(emp.code)+'&yard='+encodeURIComponent(yard)+'&dates='+encodeURIComponent(iso.join(','))+'&pdate='+encodeURIComponent(awolISO(todayKey()));
  const text=`🚨 <b>AWOL — Account Suspended</b>\n👤 ${emp.name} (${emp.code}) · 🏢 ${yard}\n📅 Absent: ${iso.join(', ')} · Suspended: ${todayKey()}\n📄 Printable letter: ${letter}`;
  const buttons=[
    {text:'✅ Reinstate',callback_data:`approve_reinstate_${emp.code}_${Date.now()}`},
    {text:'❌ Keep Suspended',callback_data:`reject_reinstate_${emp.code}_${Date.now()}`}
  ];
  let chat='',msgId=0;
  if(tgAwolGroup){ chat=tgAwolGroup; msgId=await tgSendWithButtons(tgAwolGroup,text,buttons); }
  else { for(const id of mgrIds){ if(!id)continue; const m=await tgSendWithButtons(id,text,buttons); if(m&&!msgId){chat=id;msgId=m;} } }
  if(msgId){ try{ await sbClient.from('employee_suspensions').update({awol_group_msg_id:String(msgId),awol_group_chat:String(chat)}).eq('employee_code',emp.code); }catch(e){} }
}
// HOLD note (one-time) for a 3+-day absence covered by a still-Pending leave.
async function sendAwolPendingFlag(emp,iso){
  logNotif(`⏸ ${emp.name} AWOL held (pending leave)`,'late-n',true);
  if(!tgToken||tgToken.length<20)return;
  const yard=siteNorm(emp.homeSite||activeSite||'');
  const text=`⏸ <b>Pending leave — please decide</b>\n👤 ${emp.name} (${emp.code}) · 🏢 ${yard}\nAbsent 3+ days but has a PENDING leave for ${iso.join(', ')}. Approve or Reject para ma-clear.`;
  const t=awolTarget();
  if(t) await tgSendText(t,text); else for(const id of mgrIds)if(id)await tgSendText(id,text);
}
```

- [ ] **Step 2: Write the failing scenarios** — append:

```js
await scenario('G2 · 3 absences, no leave → suspend + letter alert', manila(2026,7,24,8,0), async () => {
  mock.tgConfigured = true; mock.awolGroupId = '-1009998887776';
  await page.evaluate(() => loadTgFromCloud());
  // RSR0100 has no records for prior days → absent; ensure not already suspended.
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {}; });
  await page.evaluate(() => checkAllAbsences());
  const alert = mock.telegram.find(m => m.method === 'sendMessage' && m.chat_id === '-1009998887776' && /AWOL — Account Suspended/.test(m.text));
  const hasLetter = alert && /awol-letter\.html\?name=/.test(alert.text) && /dates=/.test(alert.text);
  const inDb = mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active === true;
  report('G2 · suspend alert to group w/ letter', !!alert && !!hasLetter && !!inDb,
    `routed=${!!alert} letter=${!!hasLetter} db=${!!inDb} buttons=${alert&&alert.hasButtons}`);
});

await scenario('G3 · pending leave → HOLD, flag once', manila(2026,7,24,8,0), async () => {
  mock.tgConfigured = true; mock.awolGroupId = '-1009998887776';
  await page.evaluate(() => loadTgFromCloud());
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {};
    leaveRequests = [{ code:'RSR0100', status:'Pending', startDate:'2026-07-21', endDate:'2026-07-24' }]; });
  await page.evaluate(() => checkAllAbsences());
  await page.evaluate(() => checkAllAbsences()); // second run must NOT re-flag
  const flags = mock.telegram.filter(m => /Pending leave — please decide/.test(m.text));
  const notSuspended = !(mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active);
  report('G3 · hold + one-time flag', flags.length === 1 && notSuspended, `flags=${flags.length} suspended=${!notSuspended}`);
});
```

- [ ] **Step 3: Run — FAIL then PASS**

Run: `node tests/kiosk-stress/kiosk-stress.mjs` → `G2`,`G3` FAIL before Step 1, PASS after. Total `46/46`.

- [ ] **Step 4: Commit**

```bash
git add kiosk/index.html tests/kiosk-stress/kiosk-stress.mjs
git commit -m "feat(kiosk): AWOL detection — hold+flag pending, dedup suspend, letter alert"
```

---

## Task 8: Kiosk — reinstatement via RPC + closing message (all 3 paths)

**Files:**
- Modify: `kiosk/index.html` — `reinstateEmployee` (~2268); Telegram reinstate callback (~4218–4233); leave-approval auto-reinstate call (~3995)

**Interfaces:**
- Consumes: `awol_reinstate` (Task 1/3), `tgSendText`, `tgEditMessage`.
- Produces: async `reinstateEmployee(code, by)`; `sendAwolReinstatedMsg(code, name, by, res)`.

- [ ] **Step 1: Replace `reinstateEmployee`** (~2268) with the DB-first version + closing message:

```js
async function reinstateEmployee(code,by){
  let res=null;
  try{ const {data}=await sbClient.rpc('awol_reinstate',{p_code:code,p_by:by||'Admin (kiosk)',p_on:todayKey()}); res=data; }
  catch(e){ res=null; }
  const newly = res ? (res.newly!==false) : true; // offline → assume newly so the local block clears
  delete suspendedEmployees[code];
  saveData();renderRoster();updateStats();
  const nm=employees.find(e=>e.code===code)?.name||code;
  logNotif(`✅ ${nm} reinstated`,'',true);
  if(newly) await sendAwolReinstatedMsg(code,nm,by||'Admin (kiosk)',res);
  loadSuspensionsFromCloud();
}
async function sendAwolReinstatedMsg(code,name,by,res){
  if(!tgToken||tgToken.length<20)return;
  const t=awolTarget();
  if(t) await tgSendText(t,`✅ <b>Reinstated</b>\n👤 ${name} (${code}) — by ${by} on ${todayKey()}`);
  const chat=res&&res.awol_group_chat, mid=res&&res.awol_group_msg_id;
  if(chat&&mid){ try{ await tgEditMessage(chat,mid,`✅ RESOLVED — ${name} reinstated ${todayKey()}`);}catch(e){} }
}
```

- [ ] **Step 2: Route the Telegram callback through the new flow** — in the reinstate callback (~4218–4233), replace the inline body of the approve branch (the `delete suspendedEmployees[empCode]` + the per-msg edit loop + `showMsg`) with:

```js
        if(action==='approve'){
          await reinstateEmployee(empCode, cb.from.first_name||'Telegram');
          await tgAnswerCallback(cb.id,'✅ Employee reinstated!');
          showMsg('ok',(employees.find(e=>e.code===empCode)?.name||empCode)+' reinstated','Employee can now punch in.',4000);
        } else {
          await tgAnswerCallback(cb.id,'Employee remains suspended.');
          logNotif(`${employees.find(e=>e.code===empCode)?.name||empCode} reinstatement denied by ${cb.from.first_name}`,'late-n',true);
        }
```
(Keep the surrounding `reqType==='reinstate'` guard and `empCode` parsing intact; only the approve/deny bodies change. The old `tgEditMessage` loop over `suspendedEmployees[empCode]?.tgMsgIds` is removed — the RESOLVED edit now comes from `sendAwolReinstatedMsg` using the DB-stored ids.)

- [ ] **Step 3: Pass a source label on leave-approval auto-reinstate** — at ~3995 change:

```js
          if(suspendedEmployees[req.code])reinstateEmployee(req.code);
```
to:
```js
          if(suspendedEmployees[req.code])reinstateEmployee(req.code,'leave approved');
```

- [ ] **Step 4: Write the failing scenario** — append:

```js
await scenario('G4 · reinstate → closing msg + RESOLVED edit, once', manila(2026,7,24,9,0), async () => {
  mock.tgConfigured = true; mock.awolGroupId = '-1005554443332';
  await page.evaluate(() => loadTgFromCloud());
  mock.suspensions['RSR0100'] = { employee_code:'RSR0100', active:true, reason:'AWOL', suspended_on:'07/24/2026',
    absent_dates:['2026-07-21','2026-07-22','2026-07-23'], awol_group_msg_id:'1234', awol_group_chat:'-1005554443332' };
  await page.evaluate(() => loadSuspensionsFromCloud());
  await page.evaluate(() => reinstateEmployee('RSR0100','Coordinator Bob'));
  await page.evaluate(() => reinstateEmployee('RSR0100','Coordinator Bob')); // second → {newly:false}, no dup
  const posts = mock.telegram.filter(m => m.method === 'sendMessage' && /Reinstated/.test(m.text));
  const edits = mock.telegram.filter(m => m.method === 'editMessageText' && /RESOLVED/.test(m.text));
  const cleared = !(mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active);
  report('G4 · reinstate closing log once', posts.length === 1 && edits.length === 1 && cleared,
    `posts=${posts.length} edits=${edits.length} cleared=${cleared}`);
});
```

- [ ] **Step 5: Run — FAIL then PASS**

Run: `node tests/kiosk-stress/kiosk-stress.mjs` → `G4` FAILs before Step 1, PASSes after. Total `47/47`.

- [ ] **Step 6: Commit**

```bash
git add kiosk/index.html tests/kiosk-stress/kiosk-stress.mjs
git commit -m "feat(kiosk): reinstate via awol_reinstate RPC + AWOL-group closing log"
```

---

## Task 9: Cross-device integration scenario

**Files:**
- Modify: `tests/kiosk-stress/kiosk-stress.mjs` — new two-context scenario

**Interfaces:**
- Consumes: everything above (the shared `mock.suspensions` is the "DB" both simulated kiosks read/write).

- [ ] **Step 1: Add a helper to open a second kiosk context** — near `newKioskContext` usage; if the harness already spins one page per `scenario`, add a lightweight second-page opener. Append this scenario (it opens its own second page against the same static server + shared `mock`):

```js
await scenario('G5 · cross-device block + clear', manila(2026,7,24,8,0), async () => {
  // Kiosk A (the scenario's page) suspends RSR0100 into the shared store.
  mock.tgConfigured = true; mock.awolGroupId = '-1006667778889';
  await page.evaluate(() => loadTgFromCloud());
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {}; });
  await page.evaluate(() => checkAllAbsences());
  const inDb = mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active === true;

  // Kiosk B: a fresh context sharing the same mocked DB. Its poll must surface the block.
  const ctxB = await newKioskContext(browser, base, manila(2026,7,24,8,5));
  const pageB = await ctxB.newPage();
  await pageB.goto(base.href + KIOSK_URL_PATH.slice(1));
  await pageB.waitForFunction(() => typeof loadSuspensionsFromCloud === 'function' && typeof punch === 'function', null, { timeout: 8000 });
  await pageB.evaluate(() => loadSuspensionsFromCloud());
  const blockedOnB = await pageB.evaluate(() => !!suspendedEmployees['RSR0100']);

  // Reinstate from A → B's next poll clears it.
  await page.evaluate(() => reinstateEmployee('RSR0100','Coordinator'));
  await pageB.evaluate(() => loadSuspensionsFromCloud());
  const clearedOnB = await pageB.evaluate(() => !suspendedEmployees['RSR0100']);
  await ctxB.close();

  report('G5 · cross-device block then clear', inDb && blockedOnB && clearedOnB,
    `A_suspended=${inDb} B_blocked=${blockedOnB} B_cleared=${clearedOnB}`);
});
```

(If `base`, `browser`, `newKioskContext`, `KIOSK_URL_PATH` are not already in scope at the scenario site, hoist the scenario into the harness's main run body where those are defined — they are module-level in `kiosk-stress.mjs`.)

- [ ] **Step 2: Run — expect PASS** (all implementation already exists from Tasks 5–8)

Run: `node tests/kiosk-stress/kiosk-stress.mjs`
Expected: `G5` PASS, total `48/48`, `azfmpleswqixaslvcito contacts: 0`.

- [ ] **Step 3: Commit**

```bash
git add tests/kiosk-stress/kiosk-stress.mjs
git commit -m "test(harness): cross-device AWOL block + clear integration scenario"
```

---

## Task 10: Preflight, full validation, deploy prep

**Files:**
- Modify: `preflight.html` (EXPECT map ~38–43)

- [ ] **Step 1: Bump the kiosk stamp + add the letter page** — in the `EXPECT` object change `'kiosk/index.html':'v2026-07-24a'` to `'v2026-07-24b'` and add an entry `'awol-letter.html':'v2026-07-24b'`.

- [ ] **Step 2: Extract + `node --check` the largest kiosk inline script**

Run:
```bash
node -e 'const fs=require("fs");const h=fs.readFileSync("kiosk/index.html","utf8");const m=[...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(x=>x[1]).sort((a,b)=>b.length-a.length)[0];fs.writeFileSync(process.env.TEMP+"/kiosk_check.mjs",m);'
node --check "$TEMP/kiosk_check.mjs" && echo KIOSK_OK
```
Expected: `KIOSK_OK`.

- [ ] **Step 3: Hygiene grep across the deliverables**

Run:
```bash
grep -c wpmcbjrisuyjvobvzaus kiosk/index.html          # expect >= 1
grep -c azfmpleswqixaslvcito kiosk/index.html awol-letter.html awol-suspensions.sql preflight.html  # expect all 0
```

- [ ] **Step 4: Run the full harness — all green**

Run: `node tests/kiosk-stress/kiosk-stress.mjs`
Expected: `48/48 checks passed · 0 bug finding(s)`, `live Supabase host never reached`, `azfmpleswqixaslvcito contacts: 0`.

- [ ] **Step 5: Commit**

```bash
git add preflight.html
git commit -m "chore(preflight): expect kiosk v2026-07-24b + awol-letter.html"
```

- [ ] **Step 6: STOP — walkthrough gate.** Do NOT push. Hand the owner: (a) `awol-suspensions.sql` to apply (STEP 0 census first) and the `@RawDataBot` chat-ID capture steps → set `tg_awol_group`; (b) a localhost walkthrough checklist — suspend a test employee (e.g. RSR 0000 with 3 blank prior days), verify the PIN modal blocks, the AWOL-group alert + letter render with real data, then reinstate from the Staff button and the Telegram button and confirm the closing "Reinstated" + RESOLVED edit. Push to `main` only on the owner's explicit "push", then verify the live `v2026-07-24b` stamp and remind about `reset.html` on tablets.

---

## Self-Review

**Spec coverage:**
- PART 1 blocking modal → Task 6. ✓
- Detection Hold+flag → Task 7 (`checkAllAbsences`, `sendAwolPendingFlag`, one-time `awolPending`). ✓
- PART 2 letter page + link → Task 2 (page), Task 7 (`sendAwolAlert` builds the URL). ✓
- PART 3 AWOL group routing + buttons + closing log → Task 4 (config), Task 7 (alert), Task 8 (closing + RESOLVED edit). ✓
- DB-shared state + RPC dedup + poller + cutover → Task 1 (SQL), Task 3 (harness mock), Task 5 (read/poller/cutover), Task 7/8 (RPC writes). ✓
- Reinstatement all 3 paths → Task 8 (shared `reinstateEmployee`, TG callback, leave-approval). ✓
- Cross-device requirement → Task 9 scenario. ✓
- `tg_awol_group` graceful fallback → Task 4 (`awolTarget`), used in Task 7/8. ✓
- Version stamps + preflight + validation + walkthrough gate → Task 10. ✓

**Placeholder scan:** No TBD/TODO; every code step shows real code; scenario code is complete.

**Type consistency:** `awol_set_suspended`→boolean and `awol_reinstate`→`{newly,awol_group_msg_id,awol_group_chat}` are used identically in SQL (Task 1), mock (Task 3), and kiosk (Tasks 5/7/8). `awolISO`, `awolTarget`, `collectAbsentDates`, `loadSuspensionsFromCloud`, `sendAwolAlert`, `sendAwolReinstatedMsg`, `awolPending`/`saveAwolPending` names match across tasks. Mock fields (`mock.suspensions`, `mock.telegram`, `mock.tgConfigured`, `mock.awolGroupId`) are defined in Task 3 and consumed consistently in Tasks 4–9.
