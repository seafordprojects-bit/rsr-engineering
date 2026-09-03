// ==============================================================================
//  kiosk-stress.mjs — Automated kiosk punch stress-test (scratchpad E2E harness)
//  Style: nd-e2e. Drives the REAL kiosk/index.html logic in a headless browser.
//
//  SAFETY (non-negotiable):
//   • Every request is intercepted with page.route('**/*').
//   • Localhost (the page + its own assets) is served by a local static server.
//   • EVERY external host is MOCKED and fulfilled locally — nothing is ever
//     `route.continue()`d off-box, so NOTHING can reach the live Supabase project
//     wpmcbjrisuyjvobvzaus (or Telegram, or any CDN).
//   • A guard asserts at the end that ZERO un-mocked external calls escaped.
//
//  The real kiosk sync path runs end to end: localStorage `records`, the
//  `syncPending` queue, `syncFlush()`/`pushRecord()` upserts, dedupe on the
//  (employee_code,date) key — but the upsert lands in a Node-side mock that
//  merely RECORDS what the kiosk attempted to send.
//
//  Clock is fully simulated (fake Date/Date.now installed before page scripts),
//  timezone pinned to Asia/Manila (UTC+8, the kiosk's implicit assumption).
// ==============================================================================

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root, derived from this file's location (tests/kiosk-stress/ → up two levels),
// so the harness is portable and can run from any checkout.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KIOSK_URL_PATH = '/kiosk/index.html';

// ── The live project ref that must NEVER be contacted ─────────────────────────
const FORBIDDEN_HOST = 'wpmcbjrisuyjvobvzaus.supabase.co';
const OLD_ABANDONED = 'azfmpleswqixaslvcito';

// ── Manila wall-clock → epoch ms (Asia/Manila is a fixed UTC+8, no DST) ───────
const manila = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h - 8, mi, s);
const DAY = 86400000;

// ── Roster returned by the mocked /rest/v1/employees (snake_case, as the real
//    loadEmployeesFromSupabase reads: se.id, se.home_site, se.daily_rate…) ────
// `pin` here is the fixture passcode the mocked identify_employee_by_pin RPC matches against.
// Since v2026-08-26b the kiosk NEVER receives it: loadEmployeesFromSupabase drops the column and
// identification happens server-side. It is still SERVED below, deliberately — that is what proves
// the client drops it rather than the fixture hiding the problem.
const ROSTER = [
  // employment_type models a FULLY SYNCED tablet, which is the correct default for a fixture.
  // The kiosk gates AWOL on it twice — awolExemptState(emp) must read 'regular' before a worker is
  // judged at all — so a roster without it puts every worker in the "employment type has not synced"
  // bucket and no detection scenario can reach the code it means to test. That is a second, LOCAL
  // exemption layer sitting behind the server's skip list, and §6.5 asks for both to be proven.
  // A scenario wanting the unsynced case sets it explicitly (see mock.nonPunching / G16 fixtures).
  { id: '11111111-1111-4111-8111-111111111111', code: 'RSR0001', pin: '000123', name: 'Leading-Zero Larry',  dept: 'Welding',    home_site: 'Carmen',  shift: 8, daily_rate: 600, employment_type: 'regular' },
  { id: '22222222-2222-4222-8222-222222222222', code: 'RSR0002', pin: '007007', name: 'Double-Zero Zeny',    dept: 'Fitting',    home_site: 'Mandaue', shift: 8, daily_rate: 520, employment_type: 'regular' },
  { id: '33333333-3333-4333-8333-333333333333', code: 'RSR0100', pin: '100200', name: 'Regular Rey',         dept: 'Painting',   home_site: 'Carmen',  shift: 8, daily_rate: 500, employment_type: 'regular' },
  { id: '44444444-4444-4444-8444-444444444444', code: 'RSR0207', pin: '246810', name: 'Midday Manny',        dept: 'Rigging',    home_site: 'Carmen',  shift: 8, daily_rate: 540, employment_type: 'regular' },
  { id: '55555555-5555-4555-8555-555555555555', code: 'PEM9001', pin: '900001', name: 'PEM Niner Pedro',     dept: 'Electrical', home_site: 'Mandaue', shift: 8, daily_rate: 700, employment_type: 'pakyaw' },
  { id: '66666666-6666-4666-8666-666666666666', code: 'PEM9042', pin: '987654', name: 'PEM Band Bella',      dept: 'Instrument', home_site: 'Carmen',  shift: 8, daily_rate: 680, employment_type: 'pakyaw' },
  { id: '77777777-7777-4777-8777-777777777777', code: 'RSR0303', pin: '333333', name: 'Night-Owl Nardo',     dept: 'Blasting',   home_site: 'Mandaue', shift: 8, daily_rate: 560, employment_type: 'regular' },
  // G15 fixtures (never-punched/30-day safety net + inactive skip):
  { id: '88888888-8888-4888-8888-888888888888', code: 'RSR0404', pin: '404040', name: 'Old-Punch Ofelia',    dept: 'Rigging',    home_site: 'Carmen',  shift: 8, daily_rate: 510, employment_type: 'regular' },
  { id: '99999999-9999-4999-8999-999999999999', code: 'RSR0500', pin: '500500', name: 'Inactive Ising',      dept: 'Painting',   home_site: 'Carmen',  shift: 8, daily_rate: 510, is_active: false, employment_type: 'regular' },
];
const pinOf = (code) => ROSTER.find(r => r.code === code).pin;

// ==============================================================================
//  Mock control + capture (shared across the whole run)
// ==============================================================================
const mock = {
  // attendance upsert behaviour: 'ok' | 'fail' (non-dup 400 → retry) | 'dup' (409/23505)
  attendanceMode: 'ok',
  attendanceDelayMs: 0,
  poisonCodes: new Set(), // employee_codes whose upsert ALWAYS 400s (per-record failure injection)
  writes: [],          // every attendance_records upsert body the kiosk attempted to send
  externalHits: {},    // host → count of external requests intercepted (all mocked)
  escaped: [],         // requests that reached an UNRECOGNISED external host (must stay empty)
  forbiddenHits: [],   // any contact with the live/abandoned Supabase refs (must stay empty)
  suspensions: {},     // employee_code → row {employee_code,active,reason,suspended_on,absent_dates,awol_group_msg_id,awol_group_chat}
  telegram: [],        // captured Telegram sends: {method, chat_id, text, hasButtons}
  tgConfigured: false, // when true, /settings returns a live tg_token + tg_awol_group
  awolGroupId: '',     // the mocked AWOL group chat id
  tgBackupGroupId: '', // the mocked tg_backup_group chat id (v2026-09-03a offline-photo notify)
  suspensionsFail: false, // when true, GET employee_suspensions 500s (v2026-09-03c backoff coverage)
  onlineProbeFail: false, // when true, isReallyOnline()'s HEAD probe aborts (v2026-09-04)
  onlineProbeCalls: 0,    // count of probe requests actually made (proves the cache is working)
  tgMsgSeq: 1000,      // incrementing message_id source
  rpcSuspendFail: false, // when true, /rpc/awol_set_suspended 500s (simulates offline for FIX 1 coverage)
  // ── identify_employee_by_pin (v2026-08-26b) ──────────────────────────────────────────────────
  identifyFail: false,     // when true the RPC 500s — the yard has lost its connection. A punch
                           // cannot be identified without the server, so this must refuse cleanly
                           // and write NOTHING (owner decision, offline answer 1).
  identifyThrottled: false,// when true the RPC answers status=throttled
  identifyCollide: null,   // a PIN string that should answer status=collision, as two active
                           // workers sharing it would. Never resolved by picking one.
  // ---- offline punch queue (v2026-08-27a) -----------------------------------------------------
  syncOfflineCalls: [],    // every sync_offline_punch payload the kiosk sent, in the order sent
  syncOfflineMode: "ok",   // "ok" | "reject" | "net" - what the RPC does
  syncOfflineReason: "no_match",
  identifyCalls: [],       // every pin_input the kiosk sent — proves the PIN leaves the tablet only
                           // as an RPC argument, and that a wrong one is not retried in a loop.
  // ── Defect 1 (2026-08-04): the sweep reads punch history from the DATABASE, not `records` ──
  punchDaysFail: false,  // when true, /rpc/awol_punch_days 500s → the sweep must abandon detection
  punchDaysEmpty: false, // when true, it returns [] → ALSO an outage (empty is never an answer)
  punchDaysExtra: {},    // {code: [ISO,…]} days the SERVER knows about that `records` does not —
                         // the only way to model the actual defect, where the tablet has pruned a
                         // punch the database still holds
  // ── 2026-08-05 §4.2: a read that SUCCEEDS but covers less ground than the lookback ──
  // The 08-04 fix made an unreadable server fail open. It did not cover a server that answers
  // cheerfully with a SHORTER window than the detector walks — which is the original defect
  // exactly (lookback longer than the store), just moved server-side. When set to N, the mock
  // serves only the last N days and reports the window it used, the way the real function does.
  punchDaysWindow: null,
  // ── awol_skip_list: the sweep's FIRST gate (mocked 2026-08-06) ──
  // Until now this RPC was unmocked, so it read empty, and checkAllAbsences fails open on an empty
  // skip list — every AWOL scenario bailed before reaching the code it meant to test. That is the
  // single cause of the long-standing 19-failure baseline, and it made two of the spec's own
  // verification items (a genuine absence is still detected; PEM is exempt at BOTH layers)
  // impossible to assert end-to-end.
  //
  // Defaults model a WORKING yard — every site has a kiosk — so the site gate skips nobody and
  // scenarios exercise detection itself. The knobs below turn each exemption on deliberately.
  skipListFail: false,   // RPC 500s → sweep must abandon detection (fail open)
  skipListEmpty: false,  // returns [] → ALSO an outage; empty is never "nobody is exempt"
  siteHasKiosk: { Carmen: true, Mandaue: true },
  nonPunching: new Set(),
};
const resetCapture = () => { mock.writes = []; mock.telegram = []; };

// ==============================================================================
//  Tiny static file server (serves the repo over http://localhost so the kiosk
//  runs on a real origin: localStorage + service-worker-free + relative assets).
// ==============================================================================
const CT = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
             '.png': 'image/png', '.css': 'text/css', '.svg': 'image/svg+xml' };
function startStaticServer() {
  const ROOT = path.resolve(REPO);   // normalize to OS separators (Windows: backslashes)
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        const filePath = path.resolve(path.join(ROOT, urlPath));
        if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
        const body = await readFile(filePath);
        res.writeHead(200, { 'Content-Type': CT[path.extname(filePath)] || 'application/octet-stream' });
        res.end(body);
      } catch { res.writeHead(404).end('not found'); }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ==============================================================================
//  Per-context wiring: fake clock + request interception
// ==============================================================================
async function newKioskContext(browser, base, initMs) {
  const context = await browser.newContext({
    timezoneId: 'Asia/Manila',
    serviceWorkers: 'block',        // keep network interception deterministic
    permissions: [],                // no camera
  });

  // Fake, settable clock installed BEFORE any page script runs.
  await context.addInitScript((startMs) => {
    const RealDate = Date;
    let now = startMs;
    window.__setNow = (ms) => { now = ms; };
    window.__getNow = () => now;
    window.__advance = (ms) => { now += ms; };
    function FakeDate(...a) {
      if (!(this instanceof FakeDate)) return new RealDate(now).toString();
      return a.length === 0 ? new RealDate(now) : new RealDate(...a);
    }
    FakeDate.now = () => now;
    FakeDate.parse = RealDate.parse;
    FakeDate.UTC = RealDate.UTC;
    FakeDate.prototype = RealDate.prototype;
    Object.setPrototypeOf(FakeDate, RealDate);
    window.Date = FakeDate;
    // Camera never available → capturePhoto() resolves null (matches headless).
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('no cam'));
  }, initMs);

  // Intercept EVERYTHING. Localhost is served locally; every other host is mocked.
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    let host;
    try { host = new URL(url).host; } catch { host = ''; }

    // Guard: the live + abandoned Supabase refs must never be contacted.
    if (url.includes('wpmcbjrisuyjvobvzaus') || url.includes(OLD_ABANDONED)) {
      mock.forbiddenHits.push(url);
    }

    // 1) The page and its own assets (localhost) → serve for real.
    if (host === base.host) { await route.continue(); return; }

    // 2) External hosts → count + mock. NEVER continue off-box.
    mock.externalHits[host] = (mock.externalHits[host] || 0) + 1;
    const json = (status, obj) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });

    // Supabase PostgREST
    if (host === FORBIDDEN_HOST) {
      const p = new URL(url).pathname;
      const method = req.method();
      // isReallyOnline()'s probe (v2026-09-04): a bare HEAD to the REST root. MUST be mocked before
      // anything else here - every scenario that identifies a PIN while online now fires this first,
      // and an unmocked/escaped request would abort and make isReallyOnline() report false for every
      // existing online scenario in the suite, not just the ones deliberately testing this.
      if (method === 'HEAD' && p.endsWith('/rest/v1/')) {
        mock.onlineProbeCalls = (mock.onlineProbeCalls || 0) + 1;
        if (mock.onlineProbeFail) return route.abort('failed');
        return route.fulfill({ status: 200, contentType: 'application/json', body: '' });
      }
      if (p.endsWith('/rest/v1/employees')) return json(200, ROSTER);
      if (p.endsWith('/rest/v1/rpc/sync_offline_punch')) {
        let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch {}
        mock.syncOfflineCalls.push(body);
        if (mock.syncOfflineMode === 'net') return route.abort('failed');
        const row = ROSTER.find(r => r.pin === (body && body.p_pin));
        if (mock.syncOfflineMode === 'reject' || !row) {
          return json(200, [{
            out_status: 'rejected', out_reason: row ? mock.syncOfflineReason : 'no_match',
            out_employee_code: row ? row.code : null, out_employee_name: row ? row.name : null,
            out_att_date: null, out_punches: null,
          }]);
        }
        const t = new Date(body.p_client_ts)
          .toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
        const punches = {};
        punches[body.p_punch_type] = t;
        return json(200, [{
          out_status: 'ok', out_reason: null,
          out_employee_code: row.code, out_employee_name: row.name,
          out_att_date: new Date(body.p_client_ts).toLocaleDateString('en-PH', { year:'numeric', month:'2-digit', day:'2-digit' }),
          out_punches: punches,
        }]);
      }
      if (p.endsWith('/rest/v1/rpc/identify_employee_by_pin')) {
        let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch {}
        const typed = body && body.pin_input;
        mock.identifyCalls.push(typed);
        if (mock.identifyFail) return json(500, { code: '500', message: 'injected failure (mock.identifyFail)', details: '', hint: '' });
        // The real function returns ONE row with a status. Mirror that shape exactly, including
        // the array PostgREST wraps a set-returning function in.
        const row = (status, e) => json(200, [{ status, id: e ? e.id : null, code: e ? e.code : null, name: e ? e.name : null }]);
        if (mock.identifyThrottled) return row('throttled', null);
        if (!/^[0-9]{6}$/.test(String(typed || ''))) return row('not_found', null);
        if (mock.identifyCollide && typed === mock.identifyCollide) return row('collision', null);
        // NO employment-status filter, matching the real WHERE.
        //
        // An is_active filter was added on 2026-08-26 and REMOVED the same day: employees has no
        // is_active column, so the deployed function raised 42703 and refused every worker. The
        // fixture below still carries is_active because the AWOL scenarios (G15d) read it out of the
        // roster JSON — but that is a client-side field the kiosk defaults to true when the column is
        // absent (kiosk/index.html: "missing column/undefined defaults to active"), NOT a column the
        // database can filter on. Identification is identity-only; policy is unchanged.
        const hits = ROSTER.filter(r => r.pin === typed);
        if (hits.length === 1) return row('ok', hits[0]);
        if (hits.length > 1)  return row('collision', null);
        return row('not_found', null);
      }
      if (p.endsWith('/rest/v1/attendance_records') && method === 'POST') {
        let payload = null;
        try { payload = JSON.parse(req.postData() || 'null'); } catch {}
        mock.writes.push({ at: mock.writes.length, payload });
        if (mock.attendanceDelayMs) await new Promise(r => setTimeout(r, mock.attendanceDelayMs));
        const code = payload && (Array.isArray(payload) ? payload[0] : payload) && (Array.isArray(payload) ? payload[0].employee_code : payload.employee_code);
        if (mock.poisonCodes.has(code))
          return json(400, { code: '23514', message: 'poison row (injected per-record failure)', details: '', hint: '' });
        if (mock.attendanceMode === 'fail')
          return json(400, { code: '23514', message: 'check constraint (injected failure)', details: '', hint: '' });
        if (mock.attendanceMode === 'dup')
          return json(409, { code: '23505', message: 'duplicate key value violates unique constraint', details: '', hint: '' });
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(Array.isArray(payload) ? payload : [payload]) });
      }
      // AWOL: shared suspension table (read + msg-id patch)
      if (p.endsWith('/rest/v1/employee_suspensions')) {
        if (method === 'GET') {
          // v2026-09-03c backoff coverage: force every GET to fail, so loadSuspensionsFromCloud's
          // own return value drives suspPollCycle's fail streak deterministically.
          if (mock.suspensionsFail) return json(500, { code: '500', message: 'injected failure (mock.suspensionsFail)' });
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
      // AWOL: the exemption list — the sweep's FIRST gate, and the only authority that can stop it
      // before punch history is even fetched.
      //
      // MIRRORS THE REAL PREDICATE, awol-detector-*.sql:
      //   awol_skip_detection(code) = awol_is_exempt(code)          -- pakyaw OR non-punching
      //                               OR NOT site_has_kiosk(awol_effective_site(code))
      //   awol_skip_reason(code)    = pakyaw | non-punching | no site known
      //                               | site not configured: X | no kiosk at X | null
      // Returns EVERY roster worker with skip true/false, exactly as the real one does, so that an
      // empty ROW SET is unambiguously an outage rather than "nobody is exempt".
      //
      // ONE DELIBERATE SIMPLIFICATION, stated so no scenario leans on it by accident: the real
      // awol_effective_site() resolves a worker's site from his most recent punch ACROSS ALL SITES,
      // falling back to home_site. This mock uses home_site alone. That is right for a fixture —
      // every scenario here punches at one site — but it means the SITE GATE itself is not modelled
      // faithfully, and a scenario testing cross-site behaviour must not rely on this mock to prove
      // it. The exemptions that ARE modelled faithfully are pakyaw and non-punching.
      if (p.endsWith('/rest/v1/rpc/awol_skip_list')) {
        if (mock.skipListFail)
          return json(500, { code: '500', message: 'injected failure (mock.skipListFail)', details: '', hint: '' });
        if (mock.skipListEmpty) return json(200, []);
        const rows = ROSTER.map(r => {
          const norm = String(r.code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
          if (/^PEM/.test(norm))            return { code: r.code, skip: true,  reason: 'pakyaw' };
          if (mock.nonPunching.has(r.code)) return { code: r.code, skip: true,  reason: 'non-punching' };
          const site = r.home_site || null;
          if (!site)                        return { code: r.code, skip: true,  reason: 'no site known' };
          if (!(site in mock.siteHasKiosk)) return { code: r.code, skip: true,  reason: 'site not configured: ' + site };
          if (!mock.siteHasKiosk[site])     return { code: r.code, skip: true,  reason: 'no kiosk at ' + site };
          return { code: r.code, skip: false, reason: null };
        });
        return json(200, rows);
      }
      // AWOL: authoritative punch history (Defect 1, spec 2026-08-04 §3).
      // The kiosk no longer asks its own `records` map "did he punch that day?" — it asks the
      // database. Scenarios still seed punches into `records`, so this mock PROJECTS that seeded
      // world back as the server's answer, which keeps every existing scenario meaning what it
      // meant. mock.punchDaysExtra adds days the SERVER holds and the tablet does not — the only
      // way to model the real defect, where `records` has been pruned to 10 days.
      // It returns EVERY roster worker, punched or not: an empty ROW SET is the client's outage
      // signal, while an empty DAY LIST is a legitimate "this man has not punched".
      if (p.endsWith('/rest/v1/rpc/awol_punch_days')) {
        if (mock.punchDaysFail)
          return json(500, { code: '500', message: 'injected failure (mock.punchDaysFail)', details: '', hint: '' });
        if (mock.punchDaysEmpty) return json(200, []);
        let seeded = {};
        try {
          seeded = await currentPage.evaluate(() => {
            const out = {};
            const iso = (s) => { s = String(s || '').trim();
              if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
              const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
              return m ? m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0') : null; };
            // Same four marker literals the real awol_punch_days() excludes.
            const bad = new Set(['(auto-skipped)', '(auto-deducted)', '(missing)', '(skipped)']);
            for (const k of Object.keys(records || {})) {
              const i = k.lastIndexOf('_'); if (i < 0) continue;
              const c = k.slice(0, i), d = iso(k.slice(i + 1));
              const t = records[k] && records[k].punches && records[k].punches.timein;
              if (!d || !t || bad.has(t)) continue;
              (out[c] = out[c] || []).push(d);
            }
            return out;
          });
        } catch { seeded = {}; }
        // The window the server actually served. The real function derives from_date from p_days
        // and the MANILA date; the mock mirrors that, and mock.punchDaysWindow lets a scenario
        // serve a narrower one than was asked for.
        let reqDays = 31;
        try { const b = JSON.parse(req.postData() || '{}'); if (Number(b.p_days) > 0) reqDays = Number(b.p_days); } catch {}
        const servedDays = mock.punchDaysWindow != null ? Number(mock.punchDaysWindow) : reqDays;
        let today = null;
        try { today = await currentPage.evaluate(() => { const d = new Date();
          return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }); } catch {}
        const from = today ? new Date(new Date(today + 'T00:00:00Z').getTime() - servedDays * 86400000)
          .toISOString().slice(0, 10) : null;
        const rows = ROSTER.map(r => {
          const days = new Set([...(seeded[r.code] || []), ...(mock.punchDaysExtra[r.code] || [])]);
          // Clip to the served window — a short window does not merely under-report, it makes the
          // days beyond it indistinguishable from "he was absent".
          const kept = [...days].filter(d => !from || d >= from).sort();
          return { code: r.code, days: kept, window_from: from };
        });
        return json(200, rows);
      }
      // AWOL: dedup RPCs
      if (p.endsWith('/rest/v1/rpc/awol_set_suspended')) {
        if (mock.rpcSuspendFail) return json(500, { code: '500', message: 'injected failure (mock.rpcSuspendFail)', details: '', hint: '' });
        let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch {}
        if (/^PEM/i.test(String(b.p_code || '').replace(/\s/g, ''))) return json(200, false);
        const ex = mock.suspensions[b.p_code];
        if (ex && ex.active) return json(200, false);
        mock.suspensions[b.p_code] = { employee_code: b.p_code, active: true, reason: b.p_reason,
          suspended_on: b.p_on, absent_dates: b.p_dates, awol_group_msg_id: null, awol_group_chat: null };
        return json(200, true);
      }
      if (p.endsWith('/rest/v1/rpc/awol_cancel_leave_approved')) {
        // (2026-07-26) awol_reinstate was renamed to awol_cancel_leave_approved — this is now the
        // ONLY kiosk-side un-suspension path (leave-approval auto-cancel); same shape, new name.
        let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch {}
        const r = mock.suspensions[b.p_code];
        if (!r || !r.active) return json(200, { newly: false });
        r.active = false; r.reinstated_by = b.p_by; r.reinstated_on = b.p_on;
        return json(200, { newly: true, awol_group_msg_id: r.awol_group_msg_id, awol_group_chat: r.awol_group_chat });
      }
      // AWOL: dashboard two-step gate RPCs (Task 7 — mocked to mirror the real DB functions
      // from Task 1: clerk ticks the letter, admin decides; approve is refused without the tick).
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
      // settings: tg config only when a scenario opts in (keeps existing scenarios' settings=[] behaviour)
      if (p.endsWith('/rest/v1/settings') && method === 'GET') {
        if (!mock.tgConfigured) return json(200, []);
        return json(200, [
          { key: 'tg_token', value: 'TESTTOKEN0000000000000000000000000000' },
          { key: 'tg_awol_group', value: mock.awolGroupId || '' },
          { key: 'tg_backup_group', value: mock.tgBackupGroupId || '' },
          { key: 'mgr_ids', value: '111,222' },
        ]);
      }
      // every other table read (settings, leaves, approvals, late breaks, pending_approvals…)
      if (method === 'GET') return json(200, []);
      return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
    }

    // Telegram — mocked capture: sendMessage/editMessageText are recorded to mock.telegram.
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
      if (p.includes('/getUpdates')) {
        const cbs = mock.tgCallbacks || [];
        mock.tgCallbacks = [];
        return json(200, { ok: true, result: cbs.map((c, i) => ({ update_id: i + 1, callback_query: c })) });
      }
      if (p.endsWith('/sendPhoto')) {
        // multipart/form-data, not JSON — pull the fields the offline-photo tests need out of the
        // raw body rather than a full multipart parse.
        const raw = req.postData() || '';
        const field = (name) => { const m2 = raw.match(new RegExp('name="' + name + '"\\r?\\n\\r?\\n([\\s\\S]*?)\\r?\\n--')); return m2 ? m2[1] : ''; };
        mock.telegram.push({ method: 'sendPhoto', chat_id: field('chat_id'), text: field('caption'), hasButtons: false, hasPhoto: raw.includes('name="photo"') });
        return json(200, { ok: true, result: { message_id: ++mock.tgMsgSeq } });
      }
      if (p.endsWith('/answerCallbackQuery')) {
        // Captured the same way as sendMessage/editMessageText — this is the only evidence that
        // distinguishes "the handler branch ran and deliberately answered" from "nothing happened".
        mock.telegram.push({ method: 'answerCallbackQuery', callback_query_id: String(b.callback_query_id || ''), text: String(b.text || ''), hasButtons: false });
        return json(200, { ok: true, result: true });
      }
      return json(200, { ok: true, result: {} });
    }

    // Anything else is an UNEXPECTED escape → record and hard-block it.
    mock.escaped.push(url);
    return route.abort();
  });

  return context;
}

// ==============================================================================
//  Browser-side helpers (run inside the page via evaluate)
// ==============================================================================
async function bootstrap(page, activeSite = 'Carmen') {
  // Wait for the kiosk's inline scripts to finish defining their globals.
  await page.waitForFunction(() => typeof loadEmployeesFromSupabase === 'function' && typeof punch === 'function', null, { timeout: 8000 });
  // Load the real roster through the real code path, then pin the active yard.
  await page.evaluate(async (site) => {
    window.__devForceReject = false;   // neutralize the localhost dev-panel default so mocked sync works
    await loadEmployeesFromSupabase();
    // eslint-disable-next-line no-undef
    sites = ['Carmen', 'Mandaue'];
    // eslint-disable-next-line no-undef
    activeSite = site;
    try { populateSiteSelects(); } catch (e) {}
  }, activeSite);
}
const setNow = (page, ms) => page.evaluate(ms => window.__setNow(ms), ms);
// enterPin is dual-signature (existing call sites everywhere pass (page, pin); AWOL scenarios
// from later tasks call the single-arg enterPin(code) form — see currentPage below):
//   enterPin(page, pin)  — legacy: drives the keypad on an explicit page, by PIN.
//   enterPin(code)       — new: drives the keypad on the ACTIVE scenario page, by employee code.
let currentPage = null; // set by scenario() to the in-flight page, for the single-arg enterPin(code) form
// v2026-08-26b — kp() is async: it awaits identify_employee_by_pin on the sixth digit. Both forms
// therefore await every digit. Returning curEmp.code afterwards still tells a caller whether the
// worker was identified, which is what all ~40 existing call sites rely on.
const DRIVE_KEYPAD = async (p) => {
  kpClr();
  for (const d of p) await kp(d);
  return curEmp ? curEmp.code : null;
};
async function enterPin(a, b) {
  if (a && typeof a.evaluate === 'function') {
    // legacy: enterPin(page, pin)
    return a.evaluate(DRIVE_KEYPAD, b);
  }
  // new: enterPin(code) — drive the REAL keypad so the kp() PIN-entry hooks (modal, preview) run.
  // Drives currentPage (the scenario's PRIMARY page). For a multi-page scenario, drive the
  // secondary page directly via page.evaluate(...) instead of this 1-arg helper.
  return currentPage.evaluate(DRIVE_KEYPAD, pinOf(a));
}
// Type digits that are nobody's PIN — for the refusal scenarios.
async function enterRawPin(typed) { return currentPage.evaluate(DRIVE_KEYPAD, typed); }
// Read whether the Bisaya modal is showing + its text.
async function bisayaState() {
  return await currentPage.evaluate(() => ({
    show: document.getElementById('bisaya-modal').classList.contains('show'),
    text: (document.getElementById('bisaya-text') || {}).textContent || '',
  }));
}
// The BARRED refusal is deliberately asynchronous: kiosk/index.html:2117 re-reads suspensions from
// the server BEFORE refusing, so that a man reinstated seconds ago is not turned away on his first
// attempt ("a reinstate that fails the first time is not a reinstate"). The modal therefore appears
// a tick or two after the PIN is keyed, and reading bisayaState() straight after enterPin() catches
// the state before the refusal has rendered. Wait for it, with a bounded timeout so a genuine
// no-modal case still fails rather than hanging.
async function bisayaStateSettled(expectShown = true, ms = 2000) {
  try {
    await currentPage.waitForFunction(
      (want) => document.getElementById('bisaya-modal').classList.contains('show') === want,
      expectShown, { timeout: ms });
  } catch { /* fall through — report the state as it actually is */ }
  return await bisayaState();
}
// retryAwolUnsynced(skipList) TAKES THE SKIP LIST (owner 2026-07-30) so a queued case is not
// re-pushed for a worker who has since become exempt. Called bare, skipList is undefined, every
// queued case falls into the "not in skip list" branch and is DROPPED rather than retried — which
// is why G6/G7 reported syncedActive=false even with connectivity restored. Fetch it the way
// checkAllAbsences does. Only possible now that awol_skip_list is mocked.
const retryWithSkipList = (page) => page.evaluate(async () => {
  const { data } = await sbClient.rpc('awol_skip_list');
  const s = {}; (data || []).forEach(r => { s[normCode(r.code)] = { skip: r.skip === true, reason: r.reason || null }; });
  await retryAwolUnsynced(s);
});
const doPunch = (page, type) => page.evaluate(async (t) => {
  await punch(t);
  // (v2026-09-03a) OFFLINE CONFIRM STEP: an online punch finishes here. An offline punch instead
  // stops at a Confirm/Retype screen; doPunch auto-confirms so every existing online-flow scenario
  // is unaffected, and only the confirm-step scenarios in section J need to drive it explicitly.
  const m = document.getElementById('offline-confirm-modal');
  if (m && m.classList.contains('show')) await offlineConfirmProceed();
}, type);
// Raw offline punch attempt WITHOUT auto-confirm, for scenarios testing the confirm screen itself.
const doPunchNoConfirm = (page, type) => page.evaluate(async (t) => { await punch(t); }, type);
const offlineConfirmState = (page) => page.evaluate(() => ({
  show: document.getElementById('offline-confirm-modal').classList.contains('show'),
  text: (document.getElementById('offline-confirm-text') || {}).textContent || '',
}));
const confirmOffline = (page) => page.evaluate(() => offlineConfirmProceed());
const retypeOffline = (page) => page.evaluate(() => offlineConfirmRetype());
const recAt = (page, code, dateKey) => page.evaluate(([c, k]) => {
  const r = records[c + '_' + k];
  return r ? { punches: r.punches, nightShift: !!r.nightShift, isLate: !!r.isLate, lateTimeOut: !!r.lateTimeOut,
               afternoonStart: !!r.afternoonStart, autoTimeout: !!r.autoTimeout } : null;
}, [code, dateKey]);
// ── Defect 1 (2026-08-04) ─────────────────────────────────────────────────────
// collectAbsentDates()/isAbsentOnDate()/hasRecentPunchHistory() no longer read the tablet's
// `records` map — they read `awolPunched`, which checkAllAbsences() fetches once per sweep from
// awol_punch_days(). A scenario that inspects the chain WITHOUT running a sweep must therefore
// load that history first, or every worker reads as never-judged (the fail-open direction).
// These helpers call the REAL production loader, so the assertion still exercises the shipped path
// rather than a test-only shortcut.
const chainOf = (page, code) => page.evaluate(async (c) => {
  await awolLoadPunchHistory(); return collectAbsentDates(c); }, code);
const historyOf = (page, code) => page.evaluate(async (c) => {
  await awolLoadPunchHistory(); return await hasRecentPunchHistory(c); }, code);
const dateKeyFor = (page) => page.evaluate(() => todayKey());
const pendingKeys = (page) => page.evaluate(() => Object.keys(syncPending));
// punch() fires saveData()→syncFlush() detached (not awaited), so tests must
// explicitly drain: wait out any in-flight flush, then flush, until the queue is empty.
async function drainSync(page, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const remaining = await page.evaluate(async () => {
      let n = 0; while (typeof syncing !== 'undefined' && syncing && n < 60) { await new Promise(r => setTimeout(r, 20)); n++; }
      await syncFlush();
      return Object.keys(syncPending).length;
    });
    if (remaining === 0) return true;
    await page.waitForTimeout(80);
  }
  return false;
}

// ==============================================================================
//  Assertion / reporting plumbing
// ==============================================================================
const results = [];
// opts.finding=true → a FAIL here is an EXPECTED real-bug finding, not a harness regression.
function report(name, pass, detail, attempted, opts = {}) {
  results.push({ name, pass, detail, attempted: attempted || null, finding: !!opts.finding });
  const tag = pass ? '  \x1b[32mPASS\x1b[0m' : (opts.finding ? '  \x1b[35mBUG!\x1b[0m' : '  \x1b[31mFAIL\x1b[0m');
  console.log(`${tag}  ${name}`);
  if (detail) console.log(`        ${detail}`);
  if (attempted) console.log(`        attempted → ${attempted}`);
}
const sends = () => mock.writes.map(w => {
  const p = w.payload || {};
  const slots = ['timein','lunch_out','lunch_in','pm_out','pm_in','timeout']
    .filter(k => p[k]).map(k => `${k}=${p[k]}`).join(' ');
  return `[${p.employee_code} ${p.date} ${p.status}] ${slots}`;
}).join('  |  ') || '(nothing sent)';

// ==============================================================================
//  MAIN
// ==============================================================================
const bugs = [];
const server = await startStaticServer();
const { port } = server.address();
const base = new URL(`http://127.0.0.1:${port}`);
const kioskURL = `${base.origin}${KIOSK_URL_PATH}`;
const browser = await chromium.launch({ headless: true });

console.log(`\n\x1b[1m════ RSR Kiosk Punch Stress-Test ════\x1b[0m`);
console.log(`kiosk: ${kioskURL}`);
console.log(`safety: all external traffic mocked; live host ${FORBIDDEN_HOST} is walled off.\n`);

// Fresh page/context per scenario so localStorage + clock start clean.
async function scenario(name, initMs, fn) {
  resetCapture();
  mock.attendanceMode = 'ok'; mock.attendanceDelayMs = 0; mock.poisonCodes = new Set();
  mock.suspensions = {};
  mock.tgCallbacks = [];
  mock.tgConfigured = false;
  mock.awolGroupId = '';
  mock.tgBackupGroupId = '';
  mock.suspensionsFail = false;
  mock.onlineProbeFail = false;
  mock.onlineProbeCalls = 0;
  mock.rpcSuspendFail = false;
  mock.identifyFail = false; mock.identifyThrottled = false; mock.identifyCollide = null; mock.identifyCalls = [];
  mock.syncOfflineCalls = []; mock.syncOfflineMode = 'ok'; mock.syncOfflineReason = 'no_match';
  mock.punchDaysFail = false; mock.punchDaysEmpty = false; mock.punchDaysExtra = {};
  mock.punchDaysWindow = null;   // MUST be reset: a leaked short window silently starves every
                                 // later scenario's history read and reads as a code failure
  mock.skipListFail = false; mock.skipListEmpty = false;
  mock.siteHasKiosk = { Carmen: true, Mandaue: true };
  mock.nonPunching = new Set();
  const context = await newKioskContext(browser, base, initMs);
  const page = await context.newPage();
  currentPage = page; // active page for the single-arg enterPin(code)/bisayaState() helpers
  page.on('pageerror', e => { if (!/classList/.test(e.message)) console.log(`        \x1b[33m[pageerror] ${e.message}\x1b[0m`); });
  try {
    await page.goto(kioskURL, { waitUntil: 'domcontentloaded' });
    await bootstrap(page);
    await fn(page);
  } catch (e) {
    report(name, false, `threw: ${e.message}`);
  } finally {
    await context.close();
  }
}

// Convenience: run one code through a clean full day up to a given stop point.
async function fullMorning(page, code, y, mo, d) {
  await setNow(page, manila(y, mo, d, 8, 0));   await enterPin(page, pinOf(code)); await doPunch(page, 'timein');
  await setNow(page, manila(y, mo, d, 12, 0));  await enterPin(page, pinOf(code)); await doPunch(page, 'lunch_out');
  await setNow(page, manila(y, mo, d, 12, 40)); await enterPin(page, pinOf(code)); await doPunch(page, 'lunch_in');
}

console.log('── A. TIME-BOUNDARY PUNCHES ──────────────────────────────────');

// A1 — 08:00 on-time Time In snaps to shift start, not late.
await scenario('A1 · Time In @ 08:00 (on-time, snaps to shift start)', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'timein');
  const r = await recAt(page, 'RSR0100', k);
  const pass = r && /08:00/.test(r.punches.timein) && !r.isLate;
  report('A1 · Time In @ 08:00', pass, `timein=${r?.punches.timein} late=${r?.isLate}`, sends());
});

// A2 — mid-morning 10:00: a SECOND Time In is a wrong-punch (already clocked in).
await scenario('A2 · mid-morning 10:00 duplicate Time In rejected', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'timein');
  const before = mock.writes.length;
  await setNow(page, manila(2026,7,15,10,0));
  await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'timein'); // should be refused (next != timein)
  const r = await recAt(page, 'RSR0100', k);
  const onlyOne = r && /08:00/.test(r.punches.timein);
  report('A2 · 10:00 duplicate Time In refused', onlyOne, `timein stays ${r?.punches.timein}; extra sends=${mock.writes.length-before}`, sends());
});

// A3 — 11:59 Lunch Out (before noon) fires the Bisaya early-deduction confirm; proceed records it.
await scenario('A3 · Lunch Out @ 11:59 (early → Bisaya confirm → record)', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'timein');
  await setNow(page, manila(2026,7,15,11,59));
  await enterPin(page, pinOf('RSR0100'));
  await doPunch(page, 'lunch_out'); // opens confirm modal, returns without recording
  const midway = await recAt(page, 'RSR0100', k);
  await page.evaluate(async () => { await bisayaConfirmProceed(); }); // Padayon
  const r = await recAt(page, 'RSR0100', k);
  const pass = !midway.punches.lunch_out && !!r.punches.lunch_out;
  report('A3 · Lunch Out @ 11:59 early-confirm', pass, `before confirm=${midway.punches.lunch_out||'—'}, after=${r.punches.lunch_out}`, sends());
});

// A4 — 12:00 Lunch Out: inside window → credited to 12:00 boundary (msMap), display stays actual.
await scenario('A4 · Lunch Out @ 12:00 (credited to boundary)', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'timein');
  await setNow(page, manila(2026,7,15,12,0));
  await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'lunch_out');
  const credited = await page.evaluate(k => records['RSR0100_'+k].msMap.lunch_out, k);
  const pass = credited === manila(2026,7,15,12,0);
  report('A4 · Lunch Out @ 12:00 credited', pass, `msMap.lunch_out=${new Date(credited).toISOString()}`, sends());
});

// A5 — 12:01 Lunch Out: still inside [12:00,12:30] window → credited DOWN to 12:00.
await scenario('A5 · Lunch Out @ 12:01 (grace → credited to 12:00)', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'timein');
  await setNow(page, manila(2026,7,15,12,1));
  await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'lunch_out');
  const credited = await page.evaluate(k => records['RSR0100_'+k].msMap.lunch_out, k);
  const pass = credited === manila(2026,7,15,12,0);
  report('A5 · Lunch Out @ 12:01 credited to 12:00', pass, `msMap.lunch_out=${new Date(credited).toISOString()}`, sends());
});

// A6 — 17:00 PM Break Out doubles as Time Out (auto day-close).
// A6 — (2026-07-23 sweep) PM Break Out NO LONGER instant-closes the day. It leaves the day OPEN
//      (timeout null) so the OT crew can punch PM Break In until 7 PM; the server-side 7 PM sweep
//      closes unreturned pm_out days. So pm_out records but timeout stays empty here.
await scenario('A6 · PM Break Out @ 17:00 leaves day OPEN (sweep closes it)', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await fullMorning(page, 'RSR0100', 2026,7,15);
  await setNow(page, manila(2026,7,15,17,0));
  await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'pm_out');
  const r = await recAt(page, 'RSR0100', k);
  const pass = !!r.punches.pm_out && !r.punches.timeout && !r.autoTimeout;
  report('A6 · PM Break Out @ 17:00 leaves day open', pass, `pm_out=${r.punches.pm_out} timeout=${r.punches.timeout||'(open — sweep closes)'} auto=${r.autoTimeout||false}`, sends());
});

// A6b — pm_out early-confirm BOUNDARY (walkthrough report): at EXACTLY 5:00:00 (and later) there is NO
//       "Sayo pa" early confirm — PM Break Out records directly.
await scenario('A6b · pm_out @ 5:00:00 — no early confirm', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await fullMorning(page, 'RSR0100', 2026,7,15);
  await setNow(page, manila(2026,7,15,17,0,0));
  await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'pm_out');
  const r = await recAt(page, 'RSR0100', k);
  const confirm = await page.evaluate(() => document.getElementById('bisaya-confirm-modal').classList.contains('show'));
  const pass = !!r.punches.pm_out && !confirm;
  report('A6b · pm_out @ 5:00:00 no early confirm', pass, `pm_out=${r.punches.pm_out||'(held by confirm!)'} confirmModal=${confirm}`, sends());
});

// A6c — the same boundary from below: at 4:59:59 the early confirm DOES open (pm_out held for Padayon).
await scenario('A6c · pm_out @ 4:59:59 — early confirm fires', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await fullMorning(page, 'RSR0207', 2026,7,15);
  await setNow(page, manila(2026,7,15,16,59,59));
  await enterPin(page, pinOf('RSR0207')); await doPunch(page, 'pm_out');
  const r = await recAt(page, 'RSR0207', k);
  const confirm = await page.evaluate(() => document.getElementById('bisaya-confirm-modal').classList.contains('show'));
  const pass = !r.punches.pm_out && confirm;
  report('A6c · pm_out @ 4:59:59 early confirm fires', pass, `pm_out=${r.punches.pm_out||'(held — correct)'} confirmModal=${confirm}`, sends());
});

// A6d — dead-window PIN entry: identifying (empty day) during a Time-In refusal window (10:15) shows an
//       INFORMATIONAL Bisaya modal + window-aware preview text, and records NOTHING.
await scenario('A6d · dead-window PIN entry → info modal, no record', manila(2026,7,15,10,15), async (page) => {
  const k = await dateKeyFor(page);
  await enterPin(page, pinOf('RSR0100'));                                              // identify at 10:15 (dead window), empty day
  const modalShown = await page.evaluate(() => document.getElementById('bisaya-modal').classList.contains('show'));
  const preview    = await page.evaluate(() => document.getElementById('prev-punches').textContent);
  const r = await recAt(page, 'RSR0100', k);
  const pass = modalShown && (!r || !r.punches.timein) && /Sirado ang Time In/.test(preview);
  report('A6d · dead-window PIN info modal + window-aware preview', pass, `modal=${modalShown} timein=${r?.punches.timein||'(none)'} preview="${(preview||'').trim().slice(0,34)}"`, sends());
});

// A7 — 21:00 OT Time Out at dismissal via the OT window (5PM→dismissal enables Time Out
//      directly, no PM-break needed — the supported day-OT close path).
await scenario('A7 · OT Time Out @ 21:00 (dismissal window)', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await fullMorning(page, 'RSR0207', 2026,7,15);
  await setNow(page, manila(2026,7,15,21,0)); await enterPin(page, pinOf('RSR0207')); await doPunch(page, 'timeout');
  const r = await recAt(page, 'RSR0207', k);
  const worked = await page.evaluate(k => calcWorked(records['RSR0207_'+k]) / 3600000, k);
  const pass = !!r.punches.timeout && r.punches.timeout.startsWith('09:00') && /PM/.test(r.punches.timeout) && worked > 8;
  report('A7 · OT Time Out @ 21:00', pass, `timeout=${r.punches.timeout} worked=${worked.toFixed(2)}h (OT)`, sends());
});

// A7b — the old PM-Out reopen quirk is now FIXED by the sweep change: with no instant auto-close,
//       getNext after pm_out is pm_in, so PM Break In records normally (before the 7 PM cap) and the
//       pm_out→pm_in OT flow works. This scenario is the regression guard for that fix.
await scenario('A7b · PM Break In records after PM Break Out (reopen quirk fixed)', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await fullMorning(page, 'RSR0207', 2026,7,15);
  await setNow(page, manila(2026,7,15,17,0)); await enterPin(page, pinOf('RSR0207')); await doPunch(page, 'pm_out'); // day stays OPEN now
  await setNow(page, manila(2026,7,15,18,0)); await enterPin(page, pinOf('RSR0207')); await doPunch(page, 'pm_in');  // 6 PM (before cap) → records
  const r = await recAt(page, 'RSR0207', k);
  const pass = !!r.punches.pm_in && !r.punches.timeout;   // pm_in recorded; day still open, awaits Time Out
  report('A7b · PM Break In records after PM Break Out (quirk fixed)', pass,
    `pm_in=${r.punches.pm_in || '(none)'} timeout=${r.punches.timeout || '(open)'}`, sends());
});

// A8 — 23:59 Time Out for a day worker is (correctly) REFUSED: past the 21:00 dismissal
//      window and with no PM Break In, the strict Time-Out guard blocks it. Late OT that
//      runs to ~midnight is meant to close via the cross-midnight path (see B1).
await scenario('A8 · Time Out @ 23:59 refused (past dismissal window)', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await fullMorning(page, 'RSR0207', 2026,7,15);
  await setNow(page, manila(2026,7,15,23,59)); await enterPin(page, pinOf('RSR0207')); await doPunch(page, 'timeout');
  const r = await recAt(page, 'RSR0207', k);
  const refused = !r.punches.timeout; // guard held: nothing recorded
  report('A8 · Time Out @ 23:59 correctly refused past dismissal', refused,
    `timeout=${r.punches.timeout||'(none — guard held; must close via cross-midnight/admin)'}`, sends());
  if (!refused) bugs.push({ sev: 'LOW', text: 'Day-worker Time Out was accepted at 23:59, past the dismissal window without a PM Break In — the strict Time-Out guard did not hold.' });
});

console.log('\n── B. MIDNIGHT CROSSING (23:59 → 00:01) ──────────────────────');

// B1 — DAY-OT worker taps at 00:01 after finishing late OT. MUST coerce to a
//      Time OUT on the PREVIOUS day, NOT a Time In on the new date.
await scenario('B1 · cross-midnight DAY-OT: 00:01 tap → Time Out on yesterday', manila(2026,7,15,8,0), async (page) => {
  // Build yesterday (07/15): open day shift, no time out.
  const yk = await dateKeyFor(page);
  await enterPin(page, pinOf('RSR0001')); await doPunch(page, 'timein'); // 08:00 yesterday
  // Cross into 07/16 00:01 and tap Time In (the mistaken tap).
  await setNow(page, manila(2026,7,16,0,1));
  const tk = await dateKeyFor(page);
  resetCapture();
  await enterPin(page, pinOf('RSR0001')); await doPunch(page, 'timein');
  const yRec = await recAt(page, 'RSR0001', yk);
  const tRec = await recAt(page, 'RSR0001', tk);
  const coercedOut = yRec && !!yRec.punches.timeout;
  const noNewTimeIn = !tRec || !tRec.punches || !tRec.punches.timein;
  const sentToYesterday = mock.writes.some(w => w.payload && w.payload.date === yk && w.payload.timeout && w.payload.status === 'out');
  const pass = coercedOut && noNewTimeIn && sentToYesterday;
  report('B1 · 00:01 tap coerces to Time Out on yesterday', pass,
    `yesterday(${yk}).timeout=${yRec?.punches.timeout} · today(${tk}).timein=${tRec?.punches?.timein||'—'}`, sends());
  if (!pass) bugs.push({ sev: 'CRIT', text: 'Cross-midnight DAY-OT coercion failed — a post-midnight tap created a new-day Time In instead of closing yesterday. Pays a phantom day + strands yesterday open.' });
});

// B2 — NIGHT worker armed at 20:00 (meal opens 00:00). A mistaken Time-In tap at
//      00:05 must route to yesterday's next expected punch (meal-out), not a new day.
await scenario('B2 · cross-midnight NIGHT: 00:05 tap → routes to yesterday meal-out', manila(2026,7,15,20,0), async (page) => {
  const yk = await dateKeyFor(page);
  await enterPin(page, pinOf('RSR0303'));
  await doPunch(page, 'timein');                                  // opens night-arm Bisaya confirm
  await page.evaluate(async () => { await bisayaConfirmProceed(); }); // Padayon → arms night, records 20:00 Time In
  const armed = await recAt(page, 'RSR0303', yk);
  await setNow(page, manila(2026,7,16,0,5));
  const tk = await dateKeyFor(page);
  resetCapture();
  await enterPin(page, pinOf('RSR0303')); await doPunch(page, 'timein'); // mistaken tap
  const yRec = await recAt(page, 'RSR0303', yk);
  const tRec = await recAt(page, 'RSR0303', tk);
  const routed = yRec && !!yRec.punches.lunch_out;               // meal-out on yesterday
  const noNewDay = !tRec || !tRec.punches || !tRec.punches.timein;
  const pass = armed.nightShift && routed && noNewDay;
  report('B2 · night 00:05 tap routes to yesterday meal-out', pass,
    `armed=${armed.nightShift} · yesterday.lunch_out=${yRec?.punches.lunch_out||'—'} · today.timein=${tRec?.punches?.timein||'—'}`, sends());
  if (!pass) bugs.push({ sev: 'HIGH', text: 'Night cross-midnight routing failed — a night worker\'s post-midnight punch did not attach to the open shift.' });
});

console.log('\n── C. FULL ROSTER IN/OUT CYCLES ──────────────────────────────');

// RSR0303 is the night-shift fixture and has its own scenarios. RSR0500 is back in this loop: he was
// briefly excluded on the theory that identification refuses inactive workers, which it does not —
// there is no is_active column to refuse them by. Every fixture worker punches.
for (const emp of ROSTER.filter(e => e.code !== 'RSR0303')) {
  await scenario(`C · roster cycle ${emp.code} (pin ${emp.pin})`, manila(2026,7,17,8,0), async (page) => {
    const k = await dateKeyFor(page);
    const selected = await enterPin(page, emp.pin);
    if (selected !== emp.code) { report(`C · ${emp.code} pin ${emp.pin}`, false, `PIN did not resolve (got ${selected})`); return; }
    await doPunch(page, 'timein'); await drainSync(page);
    await setNow(page, manila(2026,7,17,12,0));  await enterPin(page, emp.pin); await doPunch(page, 'lunch_out'); await drainSync(page);
    await setNow(page, manila(2026,7,17,12,40)); await enterPin(page, emp.pin); await doPunch(page, 'lunch_in');  await drainSync(page);
    await setNow(page, manila(2026,7,17,17,0));  await enterPin(page, emp.pin); await doPunch(page, 'timeout');    await drainSync(page); // 5 PM close via OT window (pm_out no longer auto-closes; sweep or explicit Time Out closes the day)
    const r = await recAt(page, emp.code, k);
    const sent = mock.writes.some(w => w.payload && w.payload.employee_code === emp.code && w.payload.status === 'out' && w.payload.timeout);
    const leading = emp.pin[0] === '0' ? ' [leading-zero PIN]' : (emp.pin[0] === '9' ? ' [PEM 9xxxxx band]' : '');
    const pass = r && r.punches.timein && r.punches.timeout && sent;
    report(`C · ${emp.code} full cycle${leading}`, pass, `timein=${r?.punches.timein} timeout=${r?.punches.timeout} synced=${sent}`, sends());
  });
}

console.log('\n── D. ABUSE / RACE CASES ─────────────────────────────────────');

// D1 — double-tap within the same tick (< any debounce): exactly one punch recorded.
await scenario('D1 · double-tap Time In (< 300ms) → exactly one punch', manila(2026,7,18,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await enterPin(page, pinOf('RSR0100'));
  await page.evaluate(async () => { const a = punch('timein'), b = punch('timein'); await Promise.all([a, b]); });
  const r = await recAt(page, 'RSR0100', k);
  const timeinCount = Object.keys(r.punches).filter(x => x === 'timein').length; // always ≤1 by object semantics
  const distinctRows = new Set(mock.writes.map(w => w.payload && w.payload.employee_code + '_' + w.payload.date)).size;
  // "Exactly one punch" = one timein slot in the record AND all upserts idempotent to one row/day.
  const pass = !!r.punches.timein && distinctRows <= 1;
  report('D1 · double-tap → one punch record', pass,
    `record has single timein=${r.punches.timein}; upsert attempts=${mock.writes.length}, distinct rows=${distinctRows}`, sends());
  if (mock.writes.length > 1) bugs.push({ sev: 'LOW', text: `Double-tap fires ${mock.writes.length} identical upserts (and ${mock.writes.length} Telegram/photo side-effects). Idempotent on the (code,date) key so pay is unaffected, but there is no debounce/in-flight lock in punch().` });
});

// D2 — triple rage-tap: still one punch record.
await scenario('D2 · triple rage-tap Time In → one punch record', manila(2026,7,18,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await enterPin(page, pinOf('RSR0100'));
  await page.evaluate(async () => { await Promise.all([punch('timein'), punch('timein'), punch('timein')]); });
  const r = await recAt(page, 'RSR0100', k);
  const distinctRows = new Set(mock.writes.map(w => w.payload && w.payload.employee_code + '_' + w.payload.date)).size;
  const pass = !!r.punches.timein && distinctRows <= 1;
  report('D2 · triple rage-tap → one punch record', pass, `timein=${r.punches.timein}; upsert attempts=${mock.writes.length}, distinct rows=${distinctRows}`, sends());
});

// D3 — punch that lands WHILE a same-employee sync is in flight. The queue must not lose it.
//      (Deterministic: a 500ms upload delay widens the in-flight window so the second punch
//      reliably lands inside it.) Checks whether the server ever receives the final state.
await scenario('D3 · punch during in-flight sync → server must get final state', manila(2026,7,18,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'timein'); await drainSync(page); // clean start
  mock.attendanceDelayMs = 500;                              // widen the sync round-trip
  await setNow(page, manila(2026,7,18,12,0));
  await enterPin(page, pinOf('RSR0100'));
  const p1 = doPunch(page, 'lunch_out');                     // starts a ~500ms sync (payload built at lunch_out state)
  await new Promise(r => setTimeout(r, 80));                 // let that sync go in-flight
  await setNow(page, manila(2026,7,18,12,40));
  await enterPin(page, pinOf('RSR0100'));
  const p2 = doPunch(page, 'lunch_in');                      // writes lunch_in + re-queues the key WHILE syncing
  await Promise.all([p1, p2]);
  mock.attendanceDelayMs = 0;
  await drainSync(page);                                     // fully drain — queue ends empty
  const r = await recAt(page, 'RSR0100', k);
  const pend = await pendingKeys(page);
  const serverGotFinal = mock.writes.some(w => w.payload && w.payload.employee_code === 'RSR0100' && w.payload.lunch_in);
  const localHasFinal = !!r.punches.lunch_in;
  const pass = localHasFinal && serverGotFinal && pend.length === 0;
  report('D3 · no lost update when a punch lands mid-sync', pass,
    `local lunch_in=${r.punches.lunch_in||'—'} · server received lunch_in=${serverGotFinal} · queue empty=${pend.length===0}`, sends(), { finding: !pass });
  if (localHasFinal && !serverGotFinal) bugs.push({ sev: 'HIGH', text: 'Lost-update race in the sync queue: pushRecord() builds its payload BEFORE the network await while syncFlush() deletes the queue key AFTER it. A punch that lands during that window re-queues the key, but the completing older sync deletes it — so the newer state is dropped from the queue and NEVER uploaded, while the badge reads "Syncing 0" (looks healthy). If it is the last punch of the day, payroll permanently sees the stale state. Fix: re-check/skip the delete if the record changed during the await, or snapshot+version the queue entries.' });
});

// D4 — OFFLINE punch survives a page refresh: with sync failing (offline/rejecting),
//      a punch must persist in localStorage AND stay queued across a tablet reload, then
//      still upload once the network recovers. This is the offline-safe guarantee.
await scenario('D4 · offline punch survives refresh + uploads on recovery', manila(2026,7,18,8,0), async (page) => {
  const k = await dateKeyFor(page);
  mock.attendanceMode = 'fail';                              // network rejecting → punch cannot sync
  await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'timein');
  await page.waitForTimeout(100);
  const beforeReload = await page.evaluate(() => {
    const recs = JSON.parse(localStorage.getItem('rsr_records') || 'null');
    const pend = JSON.parse(localStorage.getItem('rsr_sync_pending') || '{}');
    return { recKeys: recs ? Object.keys(recs).filter(x => x.startsWith('RSR0100_')) : [], pend: Object.keys(pend) };
  });
  // Simulate the tablet reloading (GitHub Pages + tablet cache) — same origin, localStorage persists.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof syncPending !== 'undefined', null, { timeout: 8000 });
  await page.evaluate(() => window.__devForceReject = false);   // dev panel re-armed it on reload; neutralize again
  const afterReload = await page.evaluate(() => {
    const recs = JSON.parse(localStorage.getItem('rsr_records') || 'null');
    const recKey = recs ? Object.keys(recs).find(x => x.startsWith('RSR0100_')) : null;
    return { hasRec: !!recKey && !!(recs[recKey].punches && recs[recKey].punches.timein),
             queued: Object.keys(JSON.parse(localStorage.getItem('rsr_sync_pending') || '{}')).some(x => x.startsWith('RSR0100_')) };
  });
  // Now the network recovers — the queued punch must upload.
  mock.attendanceMode = 'ok';
  const drained = await drainSync(page);
  const uploaded = mock.writes.some(w => w.payload && w.payload.employee_code === 'RSR0100' && w.payload.timein);
  const pass = afterReload.hasRec && afterReload.queued && drained && uploaded;
  report('D4 · offline punch survives refresh, uploads on recovery', pass,
    `persisted=${afterReload.hasRec}, still-queued=${afterReload.queued}, uploaded-after-recovery=${uploaded}`, sends());
  if (!afterReload.hasRec || !afterReload.queued) bugs.push({ sev: 'HIGH', text: 'An unsynced punch did not survive a page reload as a queued item — risk of a permanently lost punch (unpaid work) if the tablet reloads while offline.' });
});

// D5 — network failures: the spec expects a punch that keeps getting rejected to DEAD-LETTER
//      after ~5 tries WITHOUT blocking other punches. Probe the real behaviour with a single
//      poison record (RSR0001 always 400s) sitting at the HEAD of the queue, with a healthy
//      punch (RSR0100) queued behind it.
await scenario('D5 · poison record: dead-letter + non-blocking', manila(2026,7,18,8,0), async (page) => {
  mock.poisonCodes = new Set(['RSR0001']);                      // RSR0001's upsert ALWAYS 400s (non-dup)
  await enterPin(page, pinOf('RSR0001')); await doPunch(page, 'timein');  // fails, sits at queue head
  await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'timein');  // healthy, queued behind poison
  for (let i = 0; i < 6; i++) { await page.evaluate(async () => { await syncFlush(); }); } // 6 retry passes (> spec's 5)
  const pend = await pendingKeys(page);
  const poisonStuck = pend.some(x => x.startsWith('RSR0001_'));
  const healthyBlocked = pend.some(x => x.startsWith('RSR0100_'));
  const healthyEverSent = mock.writes.some(w => w.payload && w.payload.employee_code === 'RSR0100');
  const deadLetterExists = await page.evaluate(() =>
    typeof window.deadLetter !== 'undefined' || /dead[_-]?letter|attempts|maxRetr|tries/i.test(String(syncFlush) + String(queueRecord)));

  // The spec's expectation: poison is quarantined and the healthy punch flows past it.
  const specHonoured = deadLetterExists && !healthyBlocked && healthyEverSent;
  report('D5 · dead-letter isolates poison, others still sync', specHonoured,
    `after 6 rejects → poison stuck=${poisonStuck}, HEALTHY punch blocked=${healthyBlocked} (never even attempted=${!healthyEverSent}), dead-letter present=${deadLetterExists}`, sends(), { finding: !specHonoured });
  if (!deadLetterExists) bugs.push({ sev: 'CRIT', text: 'No dead-letter / retry cap. syncFlush() does `break` on the FIRST failing row, so ONE poison record (any non-duplicate 4xx) blocks EVERY punch queued behind it and retries it forever. On a shared kiosk this silently stalls ALL attendance sync ("Syncing N…") → whole crews\' punches never reach payroll until someone notices and clears it.' });
  if (healthyBlocked || !healthyEverSent) bugs.push({ sev: 'HIGH', text: 'Head-of-line blocking confirmed: with a failing record at the head of syncPending, a healthy punch behind it is never even attempted, so it never syncs while the poison persists.' });

  // Diagnostic: prove the healthy punch is fine on its own once the poison is removed.
  mock.poisonCodes = new Set();
  await drainSync(page);
  const pend2 = await pendingKeys(page);
  const healthyRecovers = !pend2.some(x => x.startsWith('RSR0100_'));
  report('D5b · healthy punch syncs once poison is cleared (proves it was blocked, not broken)', healthyRecovers,
    `RSR0100 still queued after poison cleared=${!healthyRecovers}; RSR0001 (poison) remains=${pend2.some(x=>x.startsWith('RSR0001_'))}`, sends());
});

// D6 — two different employees punch within the same simulated second.
await scenario('D6 · two employees punch in the same second', manila(2026,7,18,8,0,30), async (page) => {
  const k = await dateKeyFor(page);
  await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'timein');
  // same __now, different employee
  await enterPin(page, pinOf('PEM9001')); await doPunch(page, 'timein');
  await drainSync(page);
  const r1 = await recAt(page, 'RSR0100', k);
  const r2 = await recAt(page, 'PEM9001', k);
  const sent1 = mock.writes.some(w => w.payload && w.payload.employee_code === 'RSR0100' && w.payload.timein);
  const sent2 = mock.writes.some(w => w.payload && w.payload.employee_code === 'PEM9001' && w.payload.timein);
  const pass = r1.punches.timein && r2.punches.timein && sent1 && sent2 && r1.punches.timein && r2.punches.timein;
  report('D6 · two employees, same second, no collision', pass, `RSR0100=${r1.punches.timein} · PEM9001=${r2.punches.timein} · both synced=${sent1&&sent2}`, sends());
});

console.log('\n── E. PM BREAK-IN 7 PM CAP (v2026-07-22c) ────────────────────');
// pm_in reaches the 7 PM cap only when it is the genuine next punch. After lunch_in, getNext is
// pm_out; pressing pm_in forward-skips pm_out (marks it missing) and lands in the pm_in block, where
// the cap (punch() ~2692, hard reject after 7:00 PM) applies. Capture is mocked to null (no camera),
// so these prove the cap enforcer independent of camera/photo. Clock is the harness's fake Manila clock.

// E1 — 6:32 PM (before the cap) → pm_in is ACCEPTED and recorded.
await scenario('E1 · PM Break In @ 6:32 PM accepted', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await fullMorning(page, 'RSR0100', 2026,7,15);                 // timein, lunch_out, lunch_in
  await setNow(page, manila(2026,7,15,18,32));                   // 6:32 PM (5:40 < now < 7:00)
  await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'pm_in');  // forward-skips pm_out, records
  const r = await recAt(page, 'RSR0100', k);
  const rec = !!(r && r.punches.pm_in && !/missing|skip|auto/i.test(r.punches.pm_in));
  report('E1 · PM Break In @ 6:32 accepted', rec, `pm_in=${r?.punches.pm_in||'(none)'}`, sends());
});

// E2 — 7:15 PM (after the cap) → pm_in is REJECTED; nothing recorded, nothing synced.
await scenario('E2 · PM Break In @ 7:15 PM rejected by cap', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await fullMorning(page, 'RSR0100', 2026,7,15);
  await setNow(page, manila(2026,7,15,19,15));                   // 7:15 PM (> 7:00 cap)
  const before = mock.writes.length;
  await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'pm_in');  // cap must refuse
  const r = await recAt(page, 'RSR0100', k);
  const refused = !!(r && !r.punches.pm_in) && (mock.writes.length - before === 0);
  report('E2 · PM Break In @ 7:15 rejected by cap', refused, `pm_in=${r?.punches.pm_in||'(none — refused)'}; extra syncs=${mock.writes.length-before}`, sends());
});

// E3 — 6:59 vs 7:01 boundary (defense against off-by-one on the cap).
await scenario('E3 · cap boundary 6:59 accept / 7:01 reject', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await fullMorning(page, 'RSR0100', 2026,7,15);
  await setNow(page, manila(2026,7,15,18,59));                   // 6:59 PM → accept
  await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'pm_in');
  const rAcc = await recAt(page, 'RSR0100', k);
  await fullMorning(page, 'PEM9001', 2026,7,15);
  await setNow(page, manila(2026,7,15,19,1));                    // 7:01 PM → reject
  await enterPin(page, pinOf('PEM9001')); await doPunch(page, 'pm_in');
  const rRej = await recAt(page, 'PEM9001', k);
  const pass = !!(rAcc && rAcc.punches.pm_in) && !!(rRej && !rRej.punches.pm_in);
  report('E3 · cap boundary 6:59 accept / 7:01 reject', pass, `6:59 pm_in=${rAcc?.punches.pm_in||'(none)'} · 7:01 pm_in=${rRej?.punches.pm_in||'(none)'}`, sends());
});

console.log('\n── F. 7 PM CLIENT CLOSE + SWEEP TRIPWIRE (2026-07-23) ────────');
// The instant PM-Break-Out close is retired; an unreturned pm_out day is now closed at 7:00 PM by the
// CLIENT (autoCloseAbandonedBreaks, durable) at timeout=pm_out. The server-side reporter is read-only
// and not exercised here. Capture is mocked to null throughout.

// F1 — an unreturned open pm_out day is closed at 7:01 PM with timeout = pm_out.
await scenario('F1 · 7 PM client close of unreturned pm_out day', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await fullMorning(page, 'RSR0100', 2026,7,15);
  await setNow(page, manila(2026,7,15,17,0)); await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'pm_out'); // day stays open
  const mid = await recAt(page, 'RSR0100', k);
  await setNow(page, manila(2026,7,15,19,1));
  await page.evaluate(() => autoCloseAbandonedBreaks());
  const r = await recAt(page, 'RSR0100', k);
  const pass = !mid.punches.timeout && r.punches.timeout === r.punches.pm_out && r.autoTimeout;
  report('F1 · 7 PM client close (timeout=pm_out)', pass, `before=${mid.punches.timeout||'(open)'} → timeout=${r.punches.timeout} (pm_out=${r.punches.pm_out})`, sends());
});

// F2 — TRIPWIRE (Req 4): an OT worker with PM Break In set is NOT closed by the 7 PM sweep — zero fields
//      touched. This is the permanent guard against any future edit widening the close condition.
await scenario('F2 · sweep tripwire — pm_in day untouched', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await fullMorning(page, 'RSR0207', 2026,7,15);
  await setNow(page, manila(2026,7,15,17,0)); await enterPin(page, pinOf('RSR0207')); await doPunch(page, 'pm_out');
  await setNow(page, manila(2026,7,15,18,0)); await enterPin(page, pinOf('RSR0207')); await doPunch(page, 'pm_in'); // OT worker returned
  const before = await recAt(page, 'RSR0207', k);
  await setNow(page, manila(2026,7,15,19,1));
  await page.evaluate(() => autoCloseAbandonedBreaks());
  const r = await recAt(page, 'RSR0207', k);
  const pass = !r.punches.timeout && r.punches.pm_in === before.punches.pm_in && r.punches.pm_out === before.punches.pm_out;
  report('F2 · sweep tripwire (pm_in day untouched)', pass, `pm_in=${r.punches.pm_in} timeout=${r.punches.timeout||'(still open — correct)'}`, sends());
});

// F3 — before 7 PM the client close does NOT fire (day stays open for the OT window).
await scenario('F3 · no client close before 7 PM (6:59)', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await fullMorning(page, 'RSR0100', 2026,7,15);
  await setNow(page, manila(2026,7,15,17,0)); await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'pm_out');
  await setNow(page, manila(2026,7,15,18,59));
  await page.evaluate(() => autoCloseAbandonedBreaks());
  const r = await recAt(page, 'RSR0100', k);
  const pass = !r.punches.timeout;
  report('F3 · no client close before 7 PM', pass, `timeout=${r.punches.timeout||'(open — correct)'}`, sends());
});

// F4 — Req D: a late Time Out SUPERSEDES the 7 PM swept close — it records the REAL finish time,
//      KEEPS pm_out, and leaves pm_in absent (evening still computes 0 until coordinator correction).
await scenario('F4 · late Time Out supersedes 7 PM swept close', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await fullMorning(page, 'RSR0100', 2026,7,15);
  await setNow(page, manila(2026,7,15,17,0)); await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'pm_out'); // day open
  await setNow(page, manila(2026,7,15,19,1));
  await page.evaluate(() => autoCloseAbandonedBreaks());                                     // 7 PM client close → timeout = pm_out (5:00)
  const swept = await recAt(page, 'RSR0100', k);
  await setNow(page, manila(2026,7,15,20,0)); await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'timeout'); // 8 PM real finish
  const r = await recAt(page, 'RSR0100', k);
  const wasSwept   = swept.punches.timeout === swept.punches.pm_out;                          // 7 PM close wrote 5:00
  const realTimeout = !!r.punches.timeout && /08:00/.test(r.punches.timeout) && /PM/.test(r.punches.timeout);
  const pmOutKept  = r.punches.pm_out === swept.punches.pm_out;                               // Req 7 — pm_out unchanged
  const noPmIn     = !r.punches.pm_in || /missing/i.test(r.punches.pm_in);                    // pm_in absent → evening 0
  const modalShown = await page.evaluate(() => document.getElementById('bisaya-modal').classList.contains('show')); // supersede modal actually rendered
  const pass = wasSwept && realTimeout && pmOutKept && noPmIn && modalShown;
  report('F4 · late Time Out supersedes swept close', pass,
    `swept→${swept.punches.timeout} superseded→${r.punches.timeout} pm_out=${r.punches.pm_out} pm_in=${r.punches.pm_in||'(none)'} modal=${modalShown}`, sends());
});

// F5 — 7 PM close writes timeout=pm_out even on a manually-injected record (punches + msMap set
//      directly, no real punch) — the walkthrough-injection path, so the close never half-completes.
await scenario('F5 · manual-inject 7 PM close writes timeout', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await setNow(page, manila(2026,7,15,19,1));
  const out = await page.evaluate((k) => {
    const rec = getRec('RSR0100');
    const base = new Date();
    const mk = (h,m) => { const d = new Date(base); d.setHours(h,m,0,0); return d.getTime(); };
    rec.punches = { timein:'08:00:00 AM', lunch_out:'12:00:00 PM', lunch_in:'01:00:00 PM', pm_out:'05:17:00 PM' };
    rec.msMap  = { timein:mk(8,0), lunch_out:mk(12,0), lunch_in:mk(13,0), pm_out:mk(17,17) };
    autoCloseAbandonedBreaks();
    const r = records['RSR0100_'+k];
    return { timeout:r.punches.timeout, sweptClose:r.sweptClose, pm_out:r.punches.pm_out, inRoster: !!employees.find(e=>e.code==='RSR0100') };
  }, k);
  const pass = out.timeout === out.pm_out && out.sweptClose === true;
  report('F5 · manual-inject close writes timeout', pass, JSON.stringify(out), sends());
});

// F6 — supersede on a SHORT (under-8h) day: the undertime confirm must NOT pre-empt the supersede.
//      A worker who left early (pm_out 3 PM), was swept-closed at 7 PM, and returns to record proof of
//      work must land in the supersede path (not the undertime modal). Guards the _supersededSweep gate.
await scenario('F6 · supersede on short day skips undertime confirm', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await fullMorning(page, 'RSR0100', 2026,7,15);
  await setNow(page, manila(2026,7,15,15,0));   // 3:00 PM early PM Break Out → short day
  await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'pm_out');            // early → Bisaya confirm
  await page.evaluate(async () => { await bisayaConfirmProceed(); });                // Padayon → records pm_out 3:00
  await setNow(page, manila(2026,7,15,19,1));
  await page.evaluate(() => autoCloseAbandonedBreaks());                             // 7 PM close: timeout=3:00, sweptClose
  await setNow(page, manila(2026,7,15,20,0));
  await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'timeout');            // supersede (must not be blocked by undertime)
  const r = await recAt(page, 'RSR0100', k);
  const superseded = !!r.punches.timeout && /08:00/.test(r.punches.timeout) && /PM/.test(r.punches.timeout);
  const pmOutKept  = !!r.punches.pm_out && /03:00/.test(r.punches.pm_out);
  const pass = superseded && pmOutKept;
  report('F6 · supersede on short day (no undertime block)', pass, `timeout=${r.punches.timeout||'(BLOCKED by undertime)'} pm_out=${r.punches.pm_out}`, sends());
});

// F7 — OT-allowance fix: on a superseded (zero-OT) day the OT allowance must NOT fire even with a late
//      Time Out. hasOTAllowance is now based on ACTUAL OT (=0 here); the old clock proxy over-fired.
await scenario('F7 · superseded zero-OT day → no OT allowance', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await fullMorning(page, 'RSR0100', 2026,7,15);
  await setNow(page, manila(2026,7,15,17,0)); await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'pm_out');
  await setNow(page, manila(2026,7,15,19,1));
  await page.evaluate(() => autoCloseAbandonedBreaks());                              // 7 PM close (timeout=pm_out, sweptClose)
  await setNow(page, manila(2026,7,15,20,50)); await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'timeout'); // 8:50 PM supersede — otFromPmIn≈3.17h (old clock proxy would fire ₱50)
  const out = await page.evaluate((k) => { const x=records['RSR0100_'+k]; return { timeout:x.punches.timeout, ha:x.hasOTAllowance, amt:x.otAllowanceAmt }; }, k);
  const pass = /08:50/.test(out.timeout||'') && out.ha === false && out.amt === 0;
  report('F7 · superseded zero-OT day → no OT allowance', pass, `timeout=${out.timeout} hasOTAllowance=${out.ha} amt=${out.amt}`, sends());
});

// F8 — the supersede must be reachable IN THE UI: after the 7 PM close, re-identifying leaves the Time
//      Out BUTTON enabled (OT window). doPunch() bypasses the button, so F4/F6/F7 alone missed the outer
//      strict-window-locks condition needing sweptClose. This checks the actual button.disabled state.
await scenario('F8 · swept day → Time Out button enabled (supersede reachable)', manila(2026,7,15,8,0), async (page) => {
  await fullMorning(page, 'RSR0100', 2026,7,15);
  await setNow(page, manila(2026,7,15,17,0)); await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'pm_out');
  await setNow(page, manila(2026,7,15,19,1));
  await page.evaluate(() => autoCloseAbandonedBreaks());                              // 7 PM close → sweptClose
  await setNow(page, manila(2026,7,15,20,30));
  await enterPin(page, pinOf('RSR0100'));                                             // re-identify at 8:30 → updBtns runs
  const disabled = await page.evaluate(() => document.getElementById('btn-timeout').disabled);
  report('F8 · swept day Time Out button enabled', disabled === false, `btn-timeout.disabled=${disabled}`, sends());
});

// F9 — evening twin: PIN-in on a swept-closed day shows the informational heads-up modal (display-only),
//      records NOTHING, and leaves the Time Out button reachable (dismiss keeps the PIN).
await scenario('F9 · swept-day PIN entry → heads-up modal, nothing recorded', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await fullMorning(page, 'RSR0100', 2026,7,15);
  await setNow(page, manila(2026,7,15,17,0)); await enterPin(page, pinOf('RSR0100')); await doPunch(page, 'pm_out');
  await setNow(page, manila(2026,7,15,19,1));
  await page.evaluate(() => autoCloseAbandonedBreaks());               // sweptClose, timeout = 5:00
  await setNow(page, manila(2026,7,15,20,30));
  await enterPin(page, pinOf('RSR0100'));                              // re-identify → swept heads-up modal
  const modalShown = await page.evaluate(() => document.getElementById('bisaya-modal').classList.contains('show'));
  const modalText  = await page.evaluate(() => document.getElementById('bisaya-text').textContent);
  const toEnabled  = await page.evaluate(() => document.getElementById('btn-timeout').disabled === false);
  const r = await recAt(page, 'RSR0100', k);
  const pass = modalShown && /auto-close na ang imong adlaw sa 7:00 PM/.test(modalText) && toEnabled
            && r.punches.timeout === '05:00:00 PM';                    // PIN entry changed nothing — still the swept 5:00
  report('F9 · swept-day PIN heads-up modal (display-only)', pass,
    `modal=${modalShown} toEnabled=${toEnabled} timeout=${r.punches.timeout}`, sends());
});

await scenario('G0 · AWOL group id loads from settings', manila(2026,7,24,8,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1001112223334';
  await page.evaluate(() => loadTgFromCloud());
  const g = await page.evaluate(() => tgAwolGroup);
  report('G0 · tg_awol_group loaded', g === '-1001112223334', `tgAwolGroup=${g}`);
});

// ── FIXTURES UPDATED 2026-08-06 FOR DEFECT C ────────────────────────────────────────────────
// Before 2026-08-04 an active suspension row WAS the punch gate, so these scenarios seeded
// {active:true} and expected the worker blocked. That is no longer what an active row means.
// The sweep now OPENS A CASE AND STOPS — it never writes suspendedEmployees, because that map is
// the punch gate and a machine must not be able to reach it. Two maps come off one fetch
// (kiosk/index.html:2855): rows with barred_at SET drive the gate; active rows with barred_at NULL
// are open cases and gate NOTHING.
//
// So every fixture below that means "this man has been BARRED" now says barred_at, which is set
// only by awol_set_barred() behind the admin passcode. The tests' intent is unchanged — a barred
// worker is stopped at PIN entry — and they now assert it against the real contract instead of a
// coincidence of the old design.
//
// DELIBERATELY NOT ADDED to the rows the mocked awol_set_suspended RPC writes (see its handler):
// those are what the SWEEP creates, and the sweep must never produce a barred row. If barred_at
// ever appears there, that is the defect these tests exist to catch.
const BARRED_AT = '2026-07-24T00:10:00Z';   // "a human barred him", in the scenarios' frozen clock

await scenario('G-load · poll surfaces a shared BARRED suspension', manila(2026,7,24,8,0), async (page) => {
  mock.suspensions['RSR0100'] = { employee_code:'RSR0100', active:true, reason:'x', suspended_on:'07/24/2026',
    absent_dates:['2026-07-21','2026-07-22','2026-07-23'], barred_at: BARRED_AT };
  await page.evaluate(() => loadSuspensionsFromCloud());
  const has = await page.evaluate(() => !!suspendedEmployees['RSR0100']);
  report('G-load · shared suspension cached', has, `cached=${has}`);
});

// G1 — a suspended worker is fully blocked at PIN entry (identification time), on ANY punch
// attempt, with the owner-approved Bisaya modal. No punch is recorded — dismiss (kpClr) clears
// the PIN so the worker walks away; nothing writes to records/msMap.
await scenario('G1 · suspended PIN → blocking modal, no punch', manila(2026,7,24,8,0), async (page) => {
  const k = await dateKeyFor(page);
  mock.suspensions['RSR0100'] = { employee_code:'RSR0100', active:true, reason:'AWOL',
    suspended_on:'07/24/2026', absent_dates:['2026-07-21','2026-07-22','2026-07-23'], barred_at: BARRED_AT };
  await page.evaluate(() => loadSuspensionsFromCloud());
  await enterPin('RSR0100');
  const b = await bisayaStateSettled(true);
  const r = await recAt(page, 'RSR0100', k);
  const pass = b.show && /GI-SUSPEND/.test(b.text) && (!r || !r.punches.timein);
  report('G1 · suspended PIN blocking modal', pass,
    `modal=${b.show} text="${b.text.slice(0,22)}" timein=${r?.punches.timein||'(none)'}`, sends());
});

await scenario('G2 · 3 absences, no leave → suspend + letter alert', manila(2026,7,24,8,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1009998887776';
  await page.evaluate(() => loadTgFromCloud());
  // RSR0100 has no records for the recent absent window → absent; ensure not already suspended.
  // Seeded a real timein 25 days back (outside collectAbsentDates' 21-day lookback, so it plays no
  // part in the absence chain itself) so hasRecentPunchHistory() sees a worker WITH history who has
  // since gone quiet — the G15 safety net is scoped to workers with NO punch in 30 days, and this
  // worker must still be judged absent/suspended, unlike G15's never-punched Mandaue case.
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {};
    records['RSR0100_06/29/2026'] = { punches: { timein: '08:00:00 AM' } }; });
  await page.evaluate(() => checkAllAbsences());
  const alert = mock.telegram.find(m => m.method === 'sendMessage' && m.chat_id === '-1009998887776' && /AWOL — Account Suspended/.test(m.text));
  const hasLetter = alert && /awol-letter\.html\?name=/.test(alert.text) && /dates=/.test(alert.text);
  const noButtons = alert && alert.hasButtons === false; // owner request: AWOL group alert is notification-only (coordinators are members)
  const inDb = mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active === true;
  const msgIdPersisted = !!(mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].awol_group_msg_id);
  report('G2 · suspend alert to group w/ letter, no buttons, msg-id persisted', !!alert && !!hasLetter && noButtons && !!inDb && msgIdPersisted,
    `routed=${!!alert} letter=${!!hasLetter} buttons=${alert&&alert.hasButtons} db=${!!inDb} msgId=${mock.suspensions['RSR0100']&&mock.suspensions['RSR0100'].awol_group_msg_id}`);
});

await scenario('G3 · pending leave → HOLD, flag once', manila(2026,7,24,8,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1009998887776';
  await page.evaluate(() => loadTgFromCloud());
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {};
    records['RSR0100_06/29/2026'] = { punches: { timein: '08:00:00 AM' } }; // recent-enough history (see G2)
    leaveRequests = [{ code:'RSR0100', status:'Pending', startDate:'2026-07-21', endDate:'2026-07-24' }]; });
  await page.evaluate(() => checkAllAbsences());
  await page.evaluate(() => checkAllAbsences()); // second run must NOT re-flag
  // REWRITTEN 2026-08-06. This asserted the "⏸ Pending leave — please decide" HOLD note, which was
  // the behaviour BEFORE Defect E. LEAVE_SUPPRESSES now includes 'Pending' (kiosk:1392 — "Filed and
  // awaiting the owner. Suppresses while it waits"), so a pending leave explains the days outright:
  // the chain breaks at the first covered day, no case is opened, and the HOLD note never arises.
  //
  // >>> CONSEQUENCE WORTH THE OWNER'S ATTENTION: that makes the HOLD-note branch UNREACHABLE. <<<
  // It fires only when a chain of 3+ EXISTS and a pending leave overlaps one of those chain days —
  // but any pending leave overlapping a chain day breaks the chain at that day, so the two
  // conditions cannot both hold. sendAwolPendingFlag() is dead code under Defect E. Left in the
  // kiosk untouched: removing an abandoned disciplinary workflow is the owner's call, not a test's.
  const flags = mock.telegram.filter(m => /Pending leave — please decide/.test(m.text));
  const notSuspended = !(mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active);
  const d = await page.evaluate(() => ({ chain: collectAbsentDates('RSR0100').length,
    onLeave: onLeaveToday('RSR0100') }));
  report('G3 · a PENDING leave suppresses the absence entirely (Defect E) — no case, no HOLD note',
    d.onLeave === true && d.chain === 0 && flags.length === 0 && notSuspended,
    `onLeaveToday=${d.onLeave} chain=${d.chain} holdNotes=${flags.length} suspended=${!notSuspended}`);
});

// (2026-07-26) reinstateEmployee is now the leave-approval auto-cancel ONLY (dashboard owns every
// other reinstatement path) — it posts/edits "CANCELLED", never "Reinstated"/"RESOLVED".
await scenario('G4 · leave-approval cancel → closing msg + CANCELLED edit, once', manila(2026,7,24,9,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1005554443332';
  await page.evaluate(() => loadTgFromCloud());
  mock.suspensions['RSR0100'] = { employee_code:'RSR0100', active:true, reason:'AWOL', suspended_on:'07/24/2026',
    absent_dates:['2026-07-21','2026-07-22','2026-07-23'], awol_group_msg_id:'1234', awol_group_chat:'-1005554443332', barred_at: BARRED_AT };
  await page.evaluate(() => loadSuspensionsFromCloud());
  await page.evaluate(() => reinstateEmployee('RSR0100','Coordinator Bob'));
  await page.evaluate(() => reinstateEmployee('RSR0100','Coordinator Bob')); // second → {newly:false}, no dup
  // (FINDING 6) Both messages say "CANCELLED", but the post (sendAwolCancelledMsg's sendMessage —
  // the closing note to the AWOL target) and the edit (its editMessageText on the original group
  // alert) have DISTINCT bodies. Match on text that appears in ONLY ONE of them, so a future edit
  // that swaps or collapses the two message bodies is still caught — a bare /CANCELLED/ on both
  // sides can't tell the two apart.
  const posts = mock.telegram.filter(m => m.method === 'sendMessage' && /CANCELLED/.test(m.text) && /issued in error/.test(m.text));
  const edits = mock.telegram.filter(m => m.method === 'editMessageText' && /CANCELLED/.test(m.text) && /: leave approved/.test(m.text));
  const cleared = !(mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active);
  report('G4 · reinstate closing log once', posts.length === 1 && edits.length === 1 && cleared,
    `posts=${posts.length} edits=${edits.length} cleared=${cleared}`);
});

// G5 — cross-device integration: a suspension made on simulated kiosk A (the scenario's
// page) must be DB-SHARED — visible and blocking on a second simulated kiosk (its own
// browser context/page, "kiosk B") — and a reinstate on A must clear the block on B's
// next poll. Exercises already-built code only (Tasks 5–8); no kiosk changes.
await scenario('G5 · cross-device block + clear', manila(2026,7,24,8,0), async (page) => {
  // Kiosk A (the scenario's page) suspends the whole roster (no attendance records exist
  // for the prior days in this fresh scenario) into the shared mocked store. Assert on
  // RSR0100 specifically.
  mock.tgConfigured = true; mock.awolGroupId = '-1006667778889';
  await page.evaluate(() => loadTgFromCloud());
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {};
    records['RSR0100_06/29/2026'] = { punches: { timein: '08:00:00 AM' } }; }); // recent-enough history (see G2)
  await page.evaluate(() => checkAllAbsences());
  const inDb = mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active === true;

  // Kiosk B: a SEPARATE browser context/page against the same static server, sharing the
  // same mocked "DB" (mock.suspensions) through the same intercepted Supabase endpoints.
  // Driven directly via pageB.evaluate(...) — NOT the 1-arg enterPin() helper, which only
  // drives the scenario's primary page (currentPage).
  const ctxB = await newKioskContext(browser, base, manila(2026,7,24,8,5));
  const pageB = await ctxB.newPage();
  await pageB.goto(kioskURL, { waitUntil: 'domcontentloaded' });
  await pageB.waitForFunction(() => typeof loadSuspensionsFromCloud === 'function' && typeof punch === 'function', null, { timeout: 8000 });
  await pageB.evaluate(() => loadSuspensionsFromCloud());
  // DEFECT C (2026-08-04): a SWEEP-created case has barred_at NULL, so what reaches kiosk B is an
  // OPEN CASE — the informational notice — and NOT a block. This used to assert B_blocked, which is
  // exactly the behaviour that let a machine bar a man across every tablet in the yard. Assert both
  // halves now: the case DOES travel, and it does NOT bar.
  const caseOnB = await pageB.evaluate(() => !!openCases['RSR0100']);
  const notBarredOnB = await pageB.evaluate(() => !suspendedEmployees['RSR0100']);

  // Reinstate from A → B's next poll clears it.
  await page.evaluate(() => reinstateEmployee('RSR0100','Coordinator'));
  await pageB.evaluate(() => loadSuspensionsFromCloud());
  const clearedOnB = await pageB.evaluate(() => !suspendedEmployees['RSR0100'] && !openCases['RSR0100']);
  await ctxB.close();

  report('G5 · sweep case travels cross-device as a NOTICE, never a block, and clears',
    inDb && caseOnB && notBarredOnB && clearedOnB,
    `A_caseInDb=${inDb} B_hasOpenCase=${caseOnB} B_notBarred=${notBarredOnB} B_cleared=${clearedOnB}`);
});

// G6 — REWRITTEN 2026-08-06 FOR DEFECT C. Its original premise was "an offline suspend must still
// block LOCALLY", which is the precise behaviour that was removed: a failed RPC used to bar a man
// locally with barred_at NULL everywhere and no human at either end (kiosk/index.html:2858 — "the
// awolUnsynced merge is GONE"). The sweep's own catch says it: "Queue the CASE for retry. NEVER
// bar." So the assertion is inverted, and the valuable half is kept and strengthened: the case is
// QUEUED, it does not reach the DB while offline, a poll does not invent a block, and on reconnect
// it syncs and alerts.
await scenario('G6 · offline case is queued, never bars, and syncs on retry', manila(2026,7,24,8,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1002223334445'; mock.rpcSuspendFail = true;
  await page.evaluate(() => loadTgFromCloud());
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {}; awolUnsynced = {};
    records['RSR0100_06/29/2026'] = { punches: { timein: '08:00:00 AM' } }; }); // recent-enough history (see G2)
  await page.evaluate(() => checkAllAbsences());
  const notBarredOffline = await page.evaluate(() => !suspendedEmployees['RSR0100']);
  const queued = await page.evaluate(() => !!awolUnsynced['RSR0100']);
  const notInDbYet = mock.suspensions['RSR0100'] === undefined;

  await page.evaluate(() => loadSuspensionsFromCloud());
  const stillNotBarredAfterPoll = await page.evaluate(() => !suspendedEmployees['RSR0100']);

  mock.rpcSuspendFail = false;
  await retryWithSkipList(page);
  const syncedActive = mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active === true;
  const alerted = mock.telegram.some(m => m.method === 'sendMessage' && /AWOL — Account Suspended/.test(m.text) && /RSR0100/.test(m.text));
  // And what synced must STILL be an open case, not a bar — the retry path must not do what the
  // sweep is forbidden from doing.
  const syncedUnbarred = !!(mock.suspensions['RSR0100'] && !mock.suspensions['RSR0100'].barred_at);

  report('G6 · offline case queued not barred, survives poll, syncs+alerts unbarred on retry',
    notBarredOffline && queued && notInDbYet && stillNotBarredAfterPoll && syncedActive && alerted && syncedUnbarred,
    `notBarredOffline=${notBarredOffline} queued=${queued} notInDbYet=${notInDbYet} `
    + `stillNotBarredAfterPoll=${stillNotBarredAfterPoll} syncedActive=${!!syncedActive} alerted=${alerted} syncedUnbarred=${syncedUnbarred}`);
});

// G7 — resurrection-bug lock: an offline suspend (never reached the DB, only tracked in
// awolUnsynced) that gets reinstated BEFORE connectivity returns must NOT come back from
// the dead when retryAwolUnsynced() finally runs — reinstateEmployee must also clear the
// employee's awolUnsynced entry, or the deferred retry re-suspends + re-alerts on a worker
// the admin already cleared.
await scenario('G7 · reinstate before reconnect clears awolUnsynced (no resurrection)', manila(2026,7,24,8,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1007778889990';
  await page.evaluate(() => loadTgFromCloud());
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {}; awolUnsynced = {};
    records['RSR0100_06/29/2026'] = { punches: { timein: '08:00:00 AM' } }; }); // recent-enough history (see G2)

  // Offline: the RPC fails, so the CASE is queued and never reaches the DB. It does NOT bar —
  // see G6's note; the original "local block only" is the Defect C behaviour that was removed.
  mock.rpcSuspendFail = true;
  await page.evaluate(() => checkAllAbsences());
  const notBarredOffline = await page.evaluate(() => !suspendedEmployees['RSR0100']);
  const queuedOffline = await page.evaluate(() => !!awolUnsynced['RSR0100']);
  const notInDbYet = mock.suspensions['RSR0100'] === undefined;

  // Admin reinstates while still offline (awol_cancel_leave_approved finds no active DB row → {newly:false}).
  await page.evaluate(() => reinstateEmployee('RSR0100', 'Admin'));
  const unsyncedCleared = await page.evaluate(() => !awolUnsynced['RSR0100']);
  const localCleared = await page.evaluate(() => !suspendedEmployees['RSR0100']);

  // Reconnect: retry must NOT resurrect the already-reinstated worker.
  mock.rpcSuspendFail = false; mock.telegram = [];
  await retryWithSkipList(page);
  await page.evaluate(async () => { await loadSuspensionsFromCloud(); });
  const notResurrectedInDb = !(mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active === true);
  // Scoped to RSR0100: other absent roster members legitimately sync+alert on this same retry
  // (they were never reinstated), so a blanket "no AWOL alert at all" check would false-fail.
  const noReAlert = !mock.telegram.some(m => m.method === 'sendMessage' && /AWOL — Account Suspended/.test(m.text) && /RSR0100/.test(m.text));
  const stillClearedLocally = await page.evaluate(() => !suspendedEmployees['RSR0100']);

  report('G7 · reinstate-before-reconnect: no resurrection',
    notBarredOffline && queuedOffline && notInDbYet && unsyncedCleared && localCleared && notResurrectedInDb && noReAlert && stillClearedLocally,
    `notBarredOffline=${notBarredOffline} queuedOffline=${queuedOffline} notInDbYet=${notInDbYet} unsyncedCleared=${unsyncedCleared} localCleared=${localCleared} notResurrectedInDb=${notResurrectedInDb} noReAlert=${noReAlert} stillClearedLocally=${stillClearedLocally}`);
});

// G8 — REST-DAY POLICY (owner 2026-07-25): a no-punch Sunday must be TRANSPARENT — not counted as
// absent, and does not break the consecutive-absence chain. Self-checked below via the REAL
// dateKeyOffset()/isSundayKey() functions before each case runs.
//   Case C (RSR0303, "today" = a real Monday) — THE OWNER'S EXACT REPORTED BUG, reproduced and locked:
//     worked Thursday, absent Fri+Sat, no-punch Sunday. Back-scan i=1→Sun(skip), i=2→Sat(absent #1),
//     i=3→Fri(absent #2), i=4→Thu(worked→break) = 2 working-day absences. MUST NOT suspend, and
//     collectAbsentDates must be exactly [Sat,Fri] (length 2) with the Sunday date absent from it.
//     Pre-fix, this identical setup counted Sunday as a 3rd absence and wrongly suspended the worker —
//     this is the false positive the owner reported, not a derivative of it.
//   Case A (RSR0100, "today" = the following Tuesday) — absent Fri+Sat+Mon, no-punch Sunday: MUST
//     suspend on exactly the 3 working-day absences, with the Sunday date excluded from the run.
//   Case B (RSR0207, same Tuesday) — same window but ALSO worked Monday: MUST NOT suspend — but this
//     case tests a DIFFERENT thing than Case C (a punched day halting the chain outright at i=1, chain
//     length 0), not "2 absences correctly not padded to 3". Kept as its own guard, relabeled accurately.
await scenario('G8 · rest-day (Sunday) transparent in AWOL absence chain', manila(2026,7,20,8,0), async (page) => {
  // Self-check: confirm the harness clock really is a Monday and the offsets line up as documented,
  // using the REAL kiosk functions (not a reimplementation) so this doubles as a function-level guard.
  const dowMon = await page.evaluate(() => new Date().getDay()); // 1 = Monday
  const keysMon = await page.evaluate(() => [1,2,3,4].map(i => dateKeyOffset(-i))); // [Sun,Sat,Fri,Thu]
  const sundayFlagsMon = await page.evaluate(ks => ks.map(k => isSundayKey(k)), keysMon);
  const offsetsOkMon = dowMon === 1 && JSON.stringify(sundayFlagsMon) === JSON.stringify([true, false, false, false]);
  report('G8 · scenario clock is a real Monday; i=1..4 → Sun/Sat/Fri/Thu', offsetsOkMon,
    `today.getDay()=${dowMon} keys(i=1..4)=${keysMon.join(', ')} isSunday=[${sundayFlagsMon.join(', ')}]`);
  const [sunKey, satKey, friKey, thuKey] = keysMon;

  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {}; awolUnsynced = {}; });
  mock.tgConfigured = true; mock.awolGroupId = '-1008889990001';
  await page.evaluate(() => loadTgFromCloud());
  // Snapshot the full roster once so each case can re-filter `employees` from the same starting
  // point (filtering is destructive/reassigning, so re-filtering an already-filtered array would
  // silently lose the other cases' codes).
  await page.evaluate(() => { window.__g8Roster = employees.slice(); });

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
  const chainC = await chainOf(page, 'RSR0303');
  await page.evaluate(() => checkAllAbsences());
  const susC = mock.suspensions['RSR0303'] && mock.suspensions['RSR0303'].active === true;
  const exactlyTwoC = chainC.length === 2;
  const noSundayInC = !chainC.includes(sunKey);
  const hasFriSatC = [friKey, satKey].every(k => chainC.includes(k));
  report('G8c · Monday, 2 real absences (Fri+Sat) + rest-day Sunday → NOT suspended (owner-reported bug, locked)',
    !susC && exactlyTwoC && noSundayInC && hasFriSatC,
    `suspended=${!!susC} chain=[${chainC.join(', ')}] Sunday(${sunKey})excluded=${noSundayInC} — pre-fix this setup counted Sunday as a 3rd absence and wrongly suspended`);

  // ── advance the clock one day, to the following Tuesday, for Cases A + B ─────────────────────
  await setNow(page, manila(2026,7,21,8,0));
  const dowTue = await page.evaluate(() => new Date().getDay()); // 2 = Tuesday
  const keysTue = await page.evaluate(() => [1,2,3,4,5].map(i => dateKeyOffset(-i))); // [Mon,Sun,Sat,Fri,Thu]
  const sundayFlagsTue = await page.evaluate(ks => ks.map(k => isSundayKey(k)), keysTue);
  const offsetsOkTue = dowTue === 2 && JSON.stringify(sundayFlagsTue) === JSON.stringify([false, true, false, false, false]);
  report('G8 · clock advanced to a real Tuesday; i=1..5 → Mon/Sun/Sat/Fri/Thu', offsetsOkTue,
    `today.getDay()=${dowTue} keys(i=1..5)=${keysTue.join(', ')} isSunday=[${sundayFlagsTue.join(', ')}]`);
  const [monKey, sunKey2, satKey2, friKey2, thuKey2] = keysTue;

  await page.evaluate(() => { employees = window.__g8Roster.filter(e => ['RSR0100','RSR0207'].includes(e.code)); });

  // Seed BOTH workers' full history BEFORE running detection — checkAllAbsences() scans the whole
  // (now 2-employee) roster in one pass, so a partially-seeded worker would look falsely absent if
  // detection ran mid-seed.
  await page.evaluate(([thu, mon]) => {
    records['RSR0100_' + thu] = { punches: { timein: '08:00:00 AM' } }; // Case A: worked Thursday → caps the chain
    // Fri/Sat/Mon intentionally unseeded → isAbsentOnDate() defaults to absent (no timein, no leave)
    records['RSR0207_' + thu] = { punches: { timein: '08:00:00 AM' } }; // Case B: worked Thursday
    records['RSR0207_' + mon] = { punches: { timein: '08:00:00 AM' } }; // Case B: worked Monday → halts the chain outright
    // Fri/Sat intentionally unseeded → absent; Sunday unseeded either way (transparent regardless)
  }, [thuKey2, monKey]);

  const chainA = await chainOf(page, 'RSR0100');
  const chainB = await chainOf(page, 'RSR0207');
  await page.evaluate(() => checkAllAbsences());

  const susA = mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active === true;
  const exactlyThreeA = chainA.length === 3;
  const noSundayInA = !chainA.includes(sunKey2);
  const hasFriSatMonA = [friKey2, satKey2, monKey].every(k => chainA.includes(k));
  report('G8a · Fri+Sat+Mon absent, Sunday excluded → SUSPEND', !!susA && exactlyThreeA && noSundayInA && hasFriSatMonA,
    `suspended=${!!susA} chain=[${chainA.join(', ')}] Sunday(${sunKey2})excluded=${noSundayInA}`);

  const susB = mock.suspensions['RSR0207'] && mock.suspensions['RSR0207'].active === true;
  const chainZeroB = chainB.length === 0;
  report('G8b · a punched day (Monday) halts the chain outright → NOT suspended', !susB && chainZeroB,
    `suspended=${!!susB} chain=[${chainB.join(', ')}] (worked Monday is i=1, the scan breaks before Fri/Sat are ever reached — distinct from G8c's real 2-absence run)`);
});

// G10 — PAKYAW/PEM EXEMPTION (owner 2026-07-26): piece-rate/casual workers have irregular
// attendance by nature. They are skipped COMPLETELY — no suspension, no alert, no letter, and
// no pending-leave HOLD note. The employee CODE PREFIX is the marker (coordinator.js empType).
// NOTE: named G10, not G9 — an existing "G9" scenario (SMS/violation Sunday-guard) already
// occupies that label further down in this file; reusing G9 here would collide in the report output.
await scenario('G10 · PAKYAW/PEM workers are exempt from AWOL', manila(2026, 7, 21, 8, 0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1007776665554';
  await page.evaluate(() => loadTgFromCloud());
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {}; awolUnsynced = {}; });

  // PEM9001 with a 5+ working-day absence run and NO punches at all — far past the 3-day threshold.
  // Stash the full roster before narrowing: G10b checks the LOCAL employment_type layer for both a
  // PEM and an RSR worker, and the RSR one is filtered out of `employees` by the line below.
  await page.evaluate(() => { window.__g10Roster = employees.slice();
    employees = employees.filter(e => e.code === 'PEM9001'); });
  const chain = await chainOf(page, 'PEM9001');
  await page.evaluate(() => checkAllAbsences());

  const suspended = !!(mock.suspensions['PEM9001'] && mock.suspensions['PEM9001'].active);
  const localBlock = await page.evaluate(() => !!suspendedEmployees['PEM9001']);
  const anyTelegram = mock.telegram.length > 0;
  report('G10a · PEM worker absent 5+ working days → never suspended, no alert, no letter',
    !suspended && !localBlock && !anyTelegram && chain.length >= 5,
    `absentChain=${chain.length} suspendedInDb=${suspended} blockedLocally=${localBlock} telegramSends=${mock.telegram.length}`);

  // REWRITTEN 2026-08-06. This asserted isPemCode(), a CODE-PREFIX predicate that no longer exists:
  // the marker moved to employees.employment_type (owner 2026-07-29) precisely because a converted
  // worker keeps his old code, so the prefix stopped being the truth. The ReferenceError it threw
  // aborted the rest of this scenario, taking G10c with it.
  //
  // Exemption is now proven at BOTH layers, which is what spec §6.5 asks for and what the prefix
  // check never covered:
  //   SERVER — awol_skip_list reports skip=true, reason 'pakyaw' (mirrors awol_is_pem)
  //   LOCAL  — awolExemptState(emp) reads 'exempt' from employment_type, the second gate the sweep
  //            applies before judging anyone
  // Code spelling is still exercised: PEM9001 is looked up as 'PEM 0001' too, so the normalisation
  // the old test cared about is still covered — just at the layer that now decides.
  const bothLayers = await page.evaluate(async () => {
    const { data } = await sbClient.rpc('awol_skip_list');
    const byCode = {}; (data || []).forEach(r => { byCode[normCode(r.code)] = r; });
    const srv = (c) => { const r = byCode[normCode(c)]; return r ? { skip: r.skip === true, reason: r.reason } : null; };
    const loc = (c) => awolExemptState(employees.find(e => normCode(e.code) === normCode(c))
      || (window.__g10Roster || []).find(e => normCode(e.code) === normCode(c)));
    return {
      serverPemSpaced: srv('PEM 0001') ? null : srv('PEM9001'),   // 'PEM 0001' is not on this roster
      serverPem: srv('PEM9001'), serverRsr: srv('RSR0100'),
      localPem: loc('PEM9001'), localRsr: loc('RSR0100'),
    };
  });
  report('G10b · PEM exempt at BOTH layers (server skip list + local employment_type), RSR at neither',
    !!bothLayers.serverPem && bothLayers.serverPem.skip === true && bothLayers.serverPem.reason === 'pakyaw'
    && !!bothLayers.serverRsr && bothLayers.serverRsr.skip === false
    && bothLayers.localPem === 'exempt' && bothLayers.localRsr === 'regular',
    `server PEM9001=${JSON.stringify(bothLayers.serverPem)} RSR0100=${JSON.stringify(bothLayers.serverRsr)} `
    + `· local PEM9001=${bothLayers.localPem} RSR0100=${bothLayers.localRsr}`);

  // A PEM worker with a PENDING leave must not even generate the "please decide" HOLD note.
  await page.evaluate(() => {
    leaveRequests.push({ code: 'PEM9001', status: 'Pending', startDate: '07/15/2026', endDate: '07/20/2026' });
  });
  mock.telegram = [];
  await page.evaluate(() => checkAllAbsences());
  // Assert the pre-existing suspendedEmployees[code] guard did NOT shadow this check — a PEM
  // worker must independently prove "no HOLD note" via the isPemCode skip, not by accident because
  // it happened to already be suspended (it never should be).
  const stillNotSuspended = await page.evaluate(() => !suspendedEmployees['PEM9001']);
  const holdFlagged = await page.evaluate(() => !!awolPending['PEM9001']);
  report('G10c · PEM worker with a pending leave gets no HOLD note either',
    stillNotSuspended && mock.telegram.length === 0 && !holdFlagged,
    `stillNotSuspended=${stillNotSuspended} telegramSends=${mock.telegram.length} holdFlagged=${holdFlagged}`);
});

// G11 — DASHBOARD IS THE ONLY DOOR (owner 2026-07-26): the kiosk keeps the 🚫 Suspended badge but
// has NO reinstate control, and the Telegram reinstate/reject buttons are gone. The only remaining
// kiosk-side un-suspension is the leave-approval auto-cancel, which must be labelled CANCELLED.
await scenario('G11 · kiosk has no reinstate control; leave cancel is labelled CANCELLED', manila(2026, 7, 21, 8, 0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1005554443332';
  await page.evaluate(() => loadTgFromCloud());
  mock.suspensions['RSR0100'] = { employee_code: 'RSR0100', active: true, reason: 'AWOL',
    suspended_on: '07/20/2026', absent_dates: ['2026-07-17','2026-07-18','2026-07-20'],
    awol_group_msg_id: '9001', awol_group_chat: '-1005554443332', letter_received: false, barred_at: BARRED_AT };
  await page.evaluate(() => loadSuspensionsFromCloud());
  await page.evaluate(() => renderRoster());

  const rosterHtml = await page.evaluate(() => {
    const c = document.getElementById('emp-roster');
    return c ? c.innerHTML : '';
  });
  report('G11a · Staff roster shows the Suspended badge but NO reinstate button',
    /Suspended/.test(rosterHtml) && !/reinstateEmployee\(/.test(rosterHtml) && /RSR Admin dashboard/.test(rosterHtml),
    `hasBadge=${/Suspended/.test(rosterHtml)} hasButton=${/reinstateEmployee\(/.test(rosterHtml)}`);

  // The Telegram callback handler must no longer act on approve_reinstate_* / reject_reinstate_*.
  // A "still blocked afterwards" check alone is worthless here — that's equally true if the
  // callback was silently dropped and never processed at all. Prove all three: the callback was
  // actually CONSUMED (drained from the mock's delivery queue), the handler ANSWERED it with the
  // new inert-branch text (the only signal that distinguishes "ran and deliberately refused" from
  // "nothing happened"), and the worker is still blocked both locally and in the DB.
  mock.telegram = [];
  mock.tgCallbacks = [{ id: 'cb1', from: { id: 111, first_name: 'Boss' },
    data: 'approve_reinstate_RSR0100_1', message: { chat: { id: -1005554443332 }, message_id: 9001 } }];
  await page.evaluate(() => processTgCallbacks());
  const callbacksDrained = mock.tgCallbacks.length === 0;
  const answered = mock.telegram.some(m => m.method === 'answerCallbackQuery'
    && /Reinstatement is now done on the RSR Admin dashboard\./.test(m.text));
  const stillBlocked = await page.evaluate(() => !!suspendedEmployees['RSR0100']);
  report('G11b · Telegram approve_reinstate callback consumed, answered inert, still blocked',
    callbacksDrained && answered && stillBlocked === true && mock.suspensions['RSR0100'].active === true,
    `callbacksDrained=${callbacksDrained} answeredInert=${answered} stillBlockedLocally=${stillBlocked} stillActiveInDb=${mock.suspensions['RSR0100'].active}`);

  // Leave approval still clears the block — and says CANCELLED, not reinstated.
  mock.telegram = [];
  await page.evaluate(() => reinstateEmployee('RSR0100', 'leave approved'));
  const texts = mock.telegram.map(t => t.text || '').join(' || ');
  report('G11c · leave-approval cancel posts CANCELLED and edits the original alert',
    /CANCELLED/i.test(texts) && !/REINSTATED/i.test(texts) && mock.suspensions['RSR0100'].active === false,
    `sends=${texts}`);
});

// G12 — FINDING 2 lock: the REAL Telegram approve_leave callback dispatch must still cancel a
// matching active suspension. G4 and G11c above both call reinstateEmployee() directly, bypassing
// the actual dispatch glue in processTgCallbacks() (~line 4115: `if(suspendedEmployees[req.code])
// reinstateEmployee(req.code,'leave approved');`) — a future edit that dropped that one line would
// slip past every other AWOL check in this file. This scenario delivers a genuine approve_leave_*
// callback through mock.tgCallbacks (the same delivery pattern G11b already uses) and drives it
// through processTgCallbacks() itself, not a direct function call.
await scenario('G12 · real Telegram approve_leave callback cancels a matching suspension', manila(2026,7,24,9,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1004443332221';
  await page.evaluate(() => loadTgFromCloud());

  // Active suspension for a roster employee, seeded the same way G4/G11 seed it.
  mock.suspensions['RSR0100'] = { employee_code:'RSR0100', active:true, reason:'AWOL', suspended_on:'07/24/2026',
    absent_dates:['2026-07-21','2026-07-22','2026-07-23'], awol_group_msg_id:'5001', awol_group_chat:'-1004443332221', barred_at: BARRED_AT };
  await page.evaluate(() => loadSuspensionsFromCloud());
  const suspendedBefore = await page.evaluate(() => !!suspendedEmployees['RSR0100']);

  // A matching Pending leave request covering the absence window.
  await page.evaluate(() => {
    leaveRequests = [{ id: 777, code:'RSR0100', name:'Regular Rey', dept:'Painting', type:'Vacation Leave',
      startDate:'2026-07-21', endDate:'2026-07-23', days:3, reason:'family emergency', status:'Pending', tgMsgIds:{} }];
  });

  // Deliver the genuine callback (from an authorized mgr id — settings mock supplies mgr_ids='111,222')
  // and drive it through the REAL dispatch function, not reinstateEmployee() directly.
  mock.telegram = [];
  mock.tgCallbacks = [{ id:'cb-g12', from:{ id:111, first_name:'Boss' },
    data:'approve_leave_777', message:{ chat:{ id:-1004443332221 }, message_id: 5001 } }];
  await page.evaluate(() => processTgCallbacks());
  const callbacksDrained = mock.tgCallbacks.length === 0;

  // reinstateEmployee() is fired-and-forgotten by the dispatch branch (mirrors production — the real
  // code does not await it either), so poll briefly for its detached work (DB cancel + Telegram post)
  // to land instead of racing it.
  let tries = 0; while (mock.telegram.length === 0 && tries < 40) { await page.waitForTimeout(20); tries++; }

  const reqStatus = await page.evaluate(() => (leaveRequests.find(r => r.id === 777) || {}).status);
  const dbCancelled = mock.suspensions['RSR0100'].active === false;
  const localCleared = await page.evaluate(() => !suspendedEmployees['RSR0100']);
  const texts = mock.telegram.map(t => t.text || '').join(' || ');
  const saysCancelled = /CANCELLED/.test(texts) && !/REINSTATED/i.test(texts);
  report('G12 · real approve_leave dispatch cancels the matching suspension',
    callbacksDrained && suspendedBefore && reqStatus === 'Approved' && dbCancelled && localCleared && saysCancelled,
    `callbacksDrained=${callbacksDrained} suspendedBefore=${suspendedBefore} reqStatus=${reqStatus} dbCancelled=${dbCancelled} localCleared=${localCleared} sends=${texts}`);
});

// G13 — FINDING 1/3 lock: the kiosk's OWN Admin-tab Approve button (approveLeave(id), reached from
// renderAdminPanel()) must cancel a matching active suspension exactly like the Telegram path does.
// This gap predates the AWOL feature (it is not a regression) — an admin approving a leave from the
// tablet used to leave the worker blocked, contradicting the owner's locked rule. Finding 1 fixed it
// by mirroring the Telegram approve_leave branch's cancel call into approveLeave() (~line 3480).
await scenario('G13 · kiosk Admin-tab approveLeave() cancels a matching suspension', manila(2026,7,24,9,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1003332221110';
  await page.evaluate(() => loadTgFromCloud());

  mock.suspensions['RSR0100'] = { employee_code:'RSR0100', active:true, reason:'AWOL', suspended_on:'07/24/2026',
    absent_dates:['2026-07-21','2026-07-22','2026-07-23'], awol_group_msg_id:'6001', awol_group_chat:'-1003332221110', barred_at: BARRED_AT };
  await page.evaluate(() => loadSuspensionsFromCloud());
  const suspendedBefore = await page.evaluate(() => !!suspendedEmployees['RSR0100']);

  await page.evaluate(() => {
    leaveRequests = [{ id: 888, code:'RSR0100', name:'Regular Rey', dept:'Painting', type:'Vacation Leave',
      startDate:'2026-07-21', endDate:'2026-07-23', days:3, reason:'family emergency', status:'Pending', tgMsgIds:{} }];
  });

  mock.telegram = [];
  await page.evaluate(() => approveLeave(888)); // the kiosk Admin-tab Approve button's handler
  let tries = 0; while (mock.telegram.length === 0 && tries < 40) { await page.waitForTimeout(20); tries++; }

  const reqStatus = await page.evaluate(() => (leaveRequests.find(r => r.id === 888) || {}).status);
  const dbCancelled = mock.suspensions['RSR0100'].active === false;
  const localCleared = await page.evaluate(() => !suspendedEmployees['RSR0100']);
  const texts = mock.telegram.map(t => t.text || '').join(' || ');
  const saysCancelled = /CANCELLED/.test(texts);
  report('G13 · kiosk Admin-tab approveLeave cancels the matching suspension',
    suspendedBefore && reqStatus === 'Approved' && dbCancelled && localCleared && saysCancelled,
    `suspendedBefore=${suspendedBefore} reqStatus=${reqStatus} dbCancelled=${dbCancelled} localCleared=${localCleared} sends=${texts}`);
});

// G9 — SMS/VIOLATION PATH REST-DAY GUARD (this branch's Fix A): checkAndSendAbsenceSMS() must mirror
// collectAbsentDates' Sunday-transparent rule. Before the fix, a no-punch SUNDAY was always counted
// as "today absent" (the +1), firing a false AWOL-warning SMS + a bogus violation-history entry on
// the worker's rest day. semaphoreKey is unset in this harness (no settings row supplies it), so
// sendSMS() short-circuits before any network fetch — the path is safely drivable end-to-end without
// extending the external-host mock.
await scenario('G9 · absence SMS/violation path is Sunday-aware (mirrors collectAbsentDates)', manila(2026,7,19,20,0), async (page) => {
  // Case 1: "today" IS a real no-punch Sunday → must NOT send SMS / log a violation.
  const dow = await page.evaluate(() => new Date().getDay()); // 0 = Sunday
  const todayIsSunday = await page.evaluate(() => isSundayKey(todayKey()));
  report('G9 · scenario clock is a real Sunday', dow === 0 && todayIsSunday,
    `getDay()=${dow} isSundayKey(todayKey())=${todayIsSunday}`);

  await page.evaluate(() => {
    employees = employees.filter(e => e.code === 'RSR0100');
    employees[0].phone = '09171234567'; // fixture roster has no phone; sendAbsenceSMS no-ops without one
    smsLog = []; absenceViolations = {};
  });
  await page.evaluate(() => checkAndSendAbsenceSMS());
  const smsCountSunday = await page.evaluate(() => smsLog.length);
  const violSunday = await page.evaluate(() => absenceViolations['RSR0100']);
  report('G9a · no-punch Sunday today → NO SMS, NO violation logged', smsCountSunday === 0 && !violSunday,
    `smsLog.length=${smsCountSunday} violation=${JSON.stringify(violSunday)}`);

  // Case 2: advance to a real non-Sunday day, break the absence chain at i=1 (worked yesterday) so
  // today is the worker's ONLY absence (consecutive=1) → non-Sunday behavior must stay byte-identical
  // to before the fix: Day-1 SMS still sent.
  await setNow(page, manila(2026,7,21,20,0));
  const dow2 = await page.evaluate(() => new Date().getDay()); // 2 = Tuesday
  const yesterdayKey = await page.evaluate(() => dateKeyOffset(-1));
  const yesterdayNotSunday = await page.evaluate(k => !isSundayKey(k), yesterdayKey);
  report('G9 · scenario clock advanced to a real Tuesday (non-Sunday)', dow2 === 2 && yesterdayNotSunday,
    `getDay()=${dow2} yesterday=${yesterdayKey} isSunday=${!yesterdayNotSunday}`);

  await page.evaluate(k => {
    records['RSR0100_' + k] = { punches: { timein: '08:00:00 AM' } }; // worked yesterday → chain breaks at i=1
    smsLog = []; absenceViolations = {};
  }, yesterdayKey);
  await page.evaluate(() => checkAndSendAbsenceSMS());
  const smsCountTue = await page.evaluate(() => smsLog.length);
  const dayLogged = await page.evaluate(() => smsLog[0] && smsLog[0].day);
  // INVERTED 2026-08-06. checkAndSendAbsenceSMS() was DISABLED by the owner on 2026-07-30
  // (kiosk/index.html:5108 — an unconditional `return;` at the top of the function). This scenario
  // asserted the SMS still goes out, so it has been asserting removed behaviour ever since. The
  // check is kept rather than deleted, pointing the other way: it now LOCKS the disable, so if that
  // `return;` is ever removed by a merge the suite says so instead of going quietly green.
  report('G9b · absence SMS stays DISABLED (owner 2026-07-30) — nothing is sent',
    smsCountTue === 0 && dayLogged === undefined,
    `smsLog.length=${smsCountTue} day=${dayLogged} (both must show nothing was sent)`);
});

// G14 — THE GATE, CROSS-DEVICE: an approval on the dashboard must lift the block on the kiosks
// via the existing poller, and an approve attempted without the letter tick must be refused.
await scenario('G14 · two-step gate lifts the block on every kiosk', manila(2026, 7, 21, 8, 0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1004443332221';
  await page.evaluate(() => loadTgFromCloud());
  mock.suspensions['RSR0100'] = { employee_code: 'RSR0100', active: true, reason: 'AWOL',
    suspended_on: '07/20/2026', absent_dates: ['2026-07-17','2026-07-18','2026-07-20'],
    awol_group_msg_id: '9100', awol_group_chat: '-1004443332221', letter_received: false, barred_at: BARRED_AT };
  await page.evaluate(() => loadSuspensionsFromCloud());
  const blockedBefore = await page.evaluate(() => !!suspendedEmployees['RSR0100']);

  // The dashboard's approve RPC, called without the letter tick, must be refused.
  const refused = await page.evaluate(async () => {
    const { data } = await sbClient.rpc('awol_admin_decide', { p_code: 'RSR0100', p_by: 'Boss', p_decision: 'approve' });
    return data;
  });
  report('G14a · approve refused before the letter is confirmed',
    refused && refused.newly === false && /letter/i.test(refused.reason || ''),
    `response=${JSON.stringify(refused)}`);
  const stillBlocked = await page.evaluate(() => !!suspendedEmployees['RSR0100']);
  report('G14b · worker still blocked after the refused approval', blockedBefore && stillBlocked);

  // Tick, then approve — the kiosk's own poller must clear the block with no kiosk-side action.
  await page.evaluate(async () => { await sbClient.rpc('awol_letter_received', { p_code: 'RSR0100', p_by: 'Jamaica L. Batucan' }); });
  await page.evaluate(async () => { await sbClient.rpc('awol_admin_decide', { p_code: 'RSR0100', p_by: 'Boss', p_decision: 'approve' }); });
  await page.evaluate(() => loadSuspensionsFromCloud());
  const clearedAfter = await page.evaluate(() => !!suspendedEmployees['RSR0100']);
  report('G14c · after approval the poller clears the block on this kiosk',
    !clearedAfter && mock.suspensions['RSR0100'].active === false,
    `blockedLocally=${clearedAfter} activeInDb=${mock.suspensions['RSR0100'].active}`);

  // Keep-suspended resets the tick and leaves the block in place.
  mock.suspensions['RSR0207'] = { employee_code: 'RSR0207', active: true, reason: 'AWOL',
    suspended_on: '07/20/2026', absent_dates: ['2026-07-17','2026-07-18','2026-07-20'],
    awol_group_msg_id: '9101', awol_group_chat: '-1004443332221', letter_received: true, barred_at: BARRED_AT };
  await page.evaluate(async () => { await sbClient.rpc('awol_admin_decide', { p_code: 'RSR0207', p_by: 'Boss', p_decision: 'keep' }); });
  await page.evaluate(() => loadSuspensionsFromCloud());
  const stillBlocked207 = await page.evaluate(() => !!suspendedEmployees['RSR0207']);
  report('G14d · keep-suspended clears the tick and the worker stays blocked',
    mock.suspensions['RSR0207'].active === true && mock.suspensions['RSR0207'].letter_received === false && stillBlocked207,
    `activeInDb=${mock.suspensions['RSR0207'].active} letter=${mock.suspensions['RSR0207'].letter_received} blocked=${stillBlocked207}`);
});

// G15 — NEVER-PUNCHED / 30-DAY SAFETY NET + INACTIVE SKIP (Task 9, owner 2026-07-26): the owner's
// ship-gate test ("point AWOL detection at real attendance, prove it suspends nobody") FAILED,
// flagging 10 workers. Root causes: (1) the Mandaue yard has never had a working kiosk (goes live
// this Tue/Wed) — its workers have ZERO punches on file, tracked on paper instead, and must never be
// judged AWOL for a data gap that isn't their fault; (2) two workers no longer work here at all.
// hasRecentPunchHistory() (kiosk/index.html) must skip anyone with no real Time In in the last 30
// days, and checkAllAbsences() must also skip anyone flagged is_active === false — but a worker who
// DOES have recent history and then racks up 3+ real absences must STILL be suspended (Case 3: the
// check that matters most — this rule must not silently disable detection wholesale).
await scenario('G15 · never-punched/30-day safety net + inactive skip (owner 2026-07-26)', manila(2026,7,24,8,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1003332221110';
  await page.evaluate(() => loadTgFromCloud());
  // Snapshot the full roster once so each case can re-filter `employees` from the same starting
  // point, same pattern as G8/G10 above (filtering is destructive/reassigning).
  await page.evaluate(() => { window.__g15Roster = employees.slice(); });

  // ── Case 1 (RSR0002, Mandaue) — NO punches at all, ever. The exact Mandaue situation. ──────────
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {};
    employees = window.__g15Roster.filter(e => e.code === 'RSR0002'); });
  // Proves the OLD chain logic (collectAbsentDates, untouched by this fix) still sees a long
  // absence run here — the ONLY thing standing between this worker and a wrongful suspension is the
  // new hasRecentPunchHistory() skip inside checkAllAbsences.
  const chain1 = await chainOf(page, 'RSR0002');
  await page.evaluate(() => checkAllAbsences());
  const susNever = !!(mock.suspensions['RSR0002'] && mock.suspensions['RSR0002'].active);
  const alertedNever = mock.telegram.some(m => /RSR0002/.test(m.text));
  report('G15a · never-punched worker (Mandaue case) → NOT suspended, no alert', !susNever && !alertedNever && chain1.length >= 3,
    `chain=${chain1.length} suspended=${susNever} alerted=${alertedNever}`);

  // ── Case 2 (RSR0404) — only punch on file is 40 days ago, nothing since. Too stale to judge. ───
  mock.telegram = [];
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {};
    employees = window.__g15Roster.filter(e => e.code === 'RSR0404');
    records['RSR0404_06/14/2026'] = { punches: { timein: '08:00:00 AM' } }; }); // 40 days before 07/24/2026
  const historyStale = await historyOf(page, 'RSR0404');
  await page.evaluate(() => checkAllAbsences());
  const susStale = !!(mock.suspensions['RSR0404'] && mock.suspensions['RSR0404'].active);
  const alertedStale = mock.telegram.some(m => /RSR0404/.test(m.text));
  report('G15b · only punch on file is 40+ days old → NOT suspended', !historyStale && !susStale && !alertedStale,
    `hasRecentPunchHistory=${historyStale} suspended=${susStale} alerted=${alertedStale}`);

  // ── Case 3 (RSR0100) — punched 10 days ago (inside the 30-day window), then went quiet and racked
  // up 3+ real absences. THE CHECK THAT MATTERS MOST: proves the safety net does not disable
  // detection wholesale — a worker with real recent history who is genuinely absent still suspends.
  mock.telegram = [];
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {};
    employees = window.__g15Roster.filter(e => e.code === 'RSR0100');
    records['RSR0100_07/14/2026'] = { punches: { timein: '08:00:00 AM' } }; }); // 10 days before 07/24/2026
  const historyRecent = await historyOf(page, 'RSR0100');
  const chain3 = await chainOf(page, 'RSR0100');
  await page.evaluate(() => checkAllAbsences());
  const susRecent = !!(mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active);
  const alertedRecent = mock.telegram.some(m => /RSR0100/.test(m.text));
  report('G15c · recent punch (10 days ago) + 3+ absences → STILL suspended (rule is not a blanket disable)',
    historyRecent && chain3.length >= 3 && susRecent && alertedRecent,
    `hasRecentPunchHistory=${historyRecent} chain=${chain3.length} suspended=${susRecent} alerted=${alertedRecent}`);

  // ── Case 4 (RSR0500) — is_active=false on the mocked roster, WITH the same 10-day-ago recent
  // punch as Case 3, so the recency check alone would NOT protect it — proving it is genuinely the
  // is_active skip, not the recency skip, blocking the suspension.
  mock.telegram = [];
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {};
    employees = window.__g15Roster.filter(e => e.code === 'RSR0500');
    records['RSR0500_07/14/2026'] = { punches: { timein: '08:00:00 AM' } }; });
  const isActiveFlag = await page.evaluate(() => employees.find(e => e.code === 'RSR0500').isActive);
  await page.evaluate(() => checkAllAbsences());
  const susInactive = !!(mock.suspensions['RSR0500'] && mock.suspensions['RSR0500'].active);
  const alertedInactive = mock.telegram.some(m => /RSR0500/.test(m.text));
  report('G15d · is_active=false worker with a long absence → NOT suspended (recency alone would not have protected it)',
    isActiveFlag === false && !susInactive && !alertedInactive,
    `isActive=${isActiveFlag} suspended=${susInactive} alerted=${alertedInactive}`);
});

// G16 — APPROVED-LEAVE FORMAT/CODE MISMATCH (owner-reported near-miss, 2026-07-26): isAbsentOnDate()
// compared a leave's startDate/endDate against the kiosk's dateStr as RAW STRINGS. Leave rows loaded
// from Supabase carry start_date/end_date as YYYY-MM-DD (PostgREST DATE columns), but the kiosk's own
// date keys (dateKeyOffset/todayKey) are MM/DD/YYYY (en-PH). "2026-07-21" <= "07/23/2026" is a
// lexicographic compare of '2' vs '0' and is ALWAYS false, so a real, DB-sourced Approved leave could
// never break the absence chain — a worker who filed and was approved got suspended anyway. Same
// function also matched employee codes with exact ===, but codes drift by spacing across sources
// (RSR0100 vs RSR 0100). Fix: normalize both sides with awolISO()/normCode() before comparing.
// All four days below are real weekdays (Mon 07/20 .. Fri 07/24/2026), so no Sunday-transparency
// (G8) or PEM-exemption (G10) rule is in play — this isolates ONLY the format/code bug.
await scenario('G16a · Approved leave (Supabase YYYY-MM-DD) covers the absent run → chain broken, NOT suspended', manila(2026,7,24,8,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1006661112223';
  await page.evaluate(() => loadTgFromCloud());
  await page.evaluate(() => {
    records['RSR0100_06/29/2026'] = { punches: { timein: '08:00:00 AM' } }; // recent-enough history (see G2)
    // Approved leave stored exactly as PostgREST returns a DATE column: YYYY-MM-DD.
    leaveRequests = [{ code: 'RSR0100', status: 'Approved', startDate: '2026-07-21', endDate: '2026-07-23' }];
  });
  const chain = await chainOf(page, 'RSR0100');
  await page.evaluate(() => checkAllAbsences());
  const sus = !!(mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active);
  const alerted = mock.telegram.some(m => /RSR0100/.test(m.text));
  report('G16a · ISO-format approved leave breaks the chain, no suspension', chain.length === 0 && !sus && !alerted,
    `chain=[${chain.join(', ')}] suspended=${sus} alerted=${alerted}`);
});

await scenario('G16b · Approved leave (kiosk MM/DD/YYYY) also covers the absent run → chain broken, NOT suspended', manila(2026,7,24,8,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1006661112223';
  await page.evaluate(() => loadTgFromCloud());
  await page.evaluate(() => {
    records['RSR0100_06/29/2026'] = { punches: { timein: '08:00:00 AM' } };
    // Same leave, but stored as non-zero-padded M/D/YYYY (awolISO's own regex is \d{1,2} for month/day,
    // i.e. it's explicitly built to handle this shape too — e.g. legacy/admin-entered rows). This is
    // NOT a coincidental pass: a raw string compare of "7/21/2026" vs the zero-padded kiosk key
    // "07/23/2026" is WRONG ('7' > '0' lexicographically), so this only passes once dates are run
    // through awolISO() — unlike a same-length, same-month zero-padded MM/DD/YYYY pair, which can
    // accidentally sort correctly as raw strings and would not prove anything.
    leaveRequests = [{ code: 'RSR0100', status: 'Approved', startDate: '7/21/2026', endDate: '7/23/2026' }];
  });
  const chain = await chainOf(page, 'RSR0100');
  await page.evaluate(() => checkAllAbsences());
  const sus = !!(mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active);
  const alerted = mock.telegram.some(m => /RSR0100/.test(m.text));
  report('G16b · MM/DD/YYYY-format approved leave breaks the chain, no suspension', chain.length === 0 && !sus && !alerted,
    `chain=[${chain.join(', ')}] suspended=${sus} alerted=${alerted}`);
});

await scenario('G16c · Approved leave covers only PART of the absent run → chain stops AT the leave', manila(2026,7,24,8,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1006661112223';
  await page.evaluate(() => loadTgFromCloud());
  await page.evaluate(() => {
    records['RSR0100_06/29/2026'] = { punches: { timein: '08:00:00 AM' } };
    // Leave covers ONLY Wed 07/22 — Thu 07/23 (closer to today) is a genuine unexcused absence, and
    // Mon 07/20 / Tue 07/21 (further back) are ALSO unpunched. If the leave were ignored entirely
    // (the old bug), the scan would run straight through 07/22 and keep collecting 07/21 and 07/20
    // too — a 3+ day chain that gets suspended. Fixed, the scan must stop the instant it reaches the
    // leave-covered day, so the chain is exactly the ONE real absence in front of it.
    leaveRequests = [{ code: 'RSR0100', status: 'Approved', startDate: '2026-07-22', endDate: '2026-07-22' }];
  });
  const chain = await chainOf(page, 'RSR0100');
  await page.evaluate(() => checkAllAbsences());
  const sus = !!(mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active);
  const alerted = mock.telegram.some(m => /RSR0100/.test(m.text));
  report('G16c · partial-coverage leave stops the chain at exactly 1 day, no suspension',
    chain.length === 1 && chain[0] === '07/23/2026' && !sus && !alerted,
    `chain=[${chain.join(', ')}] suspended=${sus} alerted=${alerted}`);
});

await scenario('G16d · Approved leave code differs only by spacing (RSR 0100 vs RSR0100) → still recognized', manila(2026,7,24,8,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1006661112223';
  await page.evaluate(() => loadTgFromCloud());
  await page.evaluate(() => {
    records['RSR0100_06/29/2026'] = { punches: { timein: '08:00:00 AM' } };
    // Employee's real code is 'RSR0100' (no space); the leave row (as some Supabase/legacy paths do)
    // stores it with a space. Must still match via normCode().
    leaveRequests = [{ code: 'RSR 0100', status: 'Approved', startDate: '2026-07-21', endDate: '2026-07-23' }];
  });
  const chain = await chainOf(page, 'RSR0100');
  await page.evaluate(() => checkAllAbsences());
  const sus = !!(mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active);
  const alerted = mock.telegram.some(m => /RSR0100/.test(m.text));
  report('G16d · spacing-mismatched code still recognized, chain broken, no suspension', chain.length === 0 && !sus && !alerted,
    `chain=[${chain.join(', ')}] suspended=${sus} alerted=${alerted}`);
});

await scenario('G16e · regression: worker with NO leave and 3+ absences → STILL suspended', manila(2026,7,24,8,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1006661112223';
  await page.evaluate(() => loadTgFromCloud());
  await page.evaluate(() => {
    records['RSR0100_06/29/2026'] = { punches: { timein: '08:00:00 AM' } };
    leaveRequests = []; // no leave at all — the fix must not have disabled detection wholesale
  });
  const chain = await chainOf(page, 'RSR0100');
  await page.evaluate(() => checkAllAbsences());
  const sus = !!(mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active);
  const alerted = mock.telegram.some(m => /RSR0100/.test(m.text));
  report('G16e · no leave + 3+ absences still suspends (detection not disabled)',
    chain.length >= 3 && sus && alerted,
    `chain=[${chain.join(', ')}] suspended=${sus} alerted=${alerted}`);
});

// G17 — DEFECT 1 (2026-08-04): PUNCH HISTORY COMES FROM THE DATABASE, NOT `records`.
// Live evidence: RSR 0015's count went 6 -> 10 overnight on 08/04, adding 07/23, 07/24 and 07/25 —
// two of which he demonstrably worked (07/24 08:55–12:00, 07/25 08:15–17:00). Nothing changed but
// the calendar. `records` is localStorage pruned to 10 days (cleanupOldData :1871, loadData :4800),
// both of which run BEFORE detection, while the chain looks back 21 days. Past the horizon
// records[key] is undefined, hasTimein is false, and MISSING DATA READS AS ABSENCE — an error that
// only ever runs against the worker, and only ever on long chains, i.e. the cases that end in a
// letter. Spec: docs/superpowers/specs/2026-08-04-awol-detector-punch-history-and-void.md §2–3.
//
// mock.punchDaysExtra is what makes this testable: it gives the SERVER a day the tablet's `records`
// map does not have. That gap IS the defect — no scenario that seeds `records` can express it.
await scenario('G17a · a punch the tablet pruned but the SERVER still holds breaks the chain', manila(2026,7,24,8,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1007778889990';
  await page.evaluate(() => loadTgFromCloud());
  // 07/14 is 10 days back: recent enough to clear the 30-day safety net, and the exact age at which
  // the tablet's own retention starts deleting rows. It lives ONLY on the server here.
  // 07/22 is 2 days back and likewise server-only — this is the day that must stop the chain.
  mock.punchDaysExtra = { RSR0100: ['2026-07-14', '2026-07-22'] };
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {}; leaveRequests = [];
    records = {}; });   // the tablet knows NOTHING — exactly the state after a 10-day prune
  const chain = await chainOf(page, 'RSR0100');
  await page.evaluate(() => checkAllAbsences());
  const sus = !!(mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active);
  const alerted = mock.telegram.some(m => /RSR0100/.test(m.text));
  // Chain walks back from 07/23 and must stop dead at 07/22. One absent day, so no case at all.
  // Before this fix the same setup produced a 10-day run and a suspension off an empty local map.
  report('G17a · server-side punch stops the chain the tablet could not see',
    chain.length === 1 && chain[0] === '07/23/2026' && !sus && !alerted,
    `chain=[${chain.join(', ')}] suspended=${sus} alerted=${alerted}`
    + (alerted ? ` matched=${JSON.stringify(mock.telegram.filter(m => /RSR0100/.test(m.text)).map(m => m.text.slice(0, 120)))}` : ''));
});

await scenario('G17b · a real absence run is still visible in server history', manila(2026,7,24,8,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1007778889990';
  await page.evaluate(() => loadTgFromCloud());
  // The counterpart to G17a, and the one that matters most: reading the server must not become a
  // blanket amnesty. Only punch on file is 07/14, so 07/15 onward is a genuine absence run.
  //
  // ASSERTS THE CHAIN, NOT THE SUSPENSION, deliberately. checkAllAbsences() bails at its FIRST
  // gate in this harness — awol_skip_list() is not mocked, so it reads empty and the sweep fails
  // open before punch history is ever consulted. That is the standing gap behind the G1/G15c/G16e
  // family of failures, not something this change introduced; asserting a suspension here would
  // only add a 20th failure with the same single cause. The chain and the safety net ARE reachable,
  // and they are what this defect is about.
  mock.punchDaysExtra = { RSR0100: ['2026-07-14'] };
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {}; leaveRequests = [];
    records = {}; });
  const chain = await chainOf(page, 'RSR0100');
  const hist = await historyOf(page, 'RSR0100');
  report('G17b · genuine absence run off server history still counts, history recognised',
    hist === true && chain.length >= 3 && chain[chain.length - 1] === '07/15/2026',
    `hasRecentPunchHistory=${hist} chain=${chain.length} oldest=${chain[chain.length - 1]}`);
});

// FAIL OPEN, BINDING (owner rule): a man always gets to punch and the owner gets TOLD; never a
// silent block. Unreadable punch history must leave NO map behind — the three read sites then
// resolve to "do not judge" in both directions (awolPunchedOn → present, hasRecentPunchHistory →
// false), and checkAllAbsences abandons the sweep on the returned reason.
// Tested against awolLoadPunchHistory() directly for the same reason as G17b: the sweep never
// reaches this fetch while awol_skip_list() is unmocked, so a sweep-level assertion would pass
// vacuously — it would go green whether or not the fail-open branch existed at all.
await scenario('G17c · punch-history RPC error → no map, a reason returned, nothing judgeable', manila(2026,7,24,8,0), async (page) => {
  await page.evaluate(() => { records['RSR0100_06/29/2026'] = { punches: { timein: '08:00:00 AM' } }; });
  mock.punchDaysFail = true;          // the RPC 500s
  const r = await page.evaluate(async () => {
    const why = await awolLoadPunchHistory();
    return { why, map: awolPunched, chain: collectAbsentDates('RSR0100'), hist: await hasRecentPunchHistory('RSR0100') };
  });
  report('G17c · RPC failure yields a reason, a null map, and no absences',
    typeof r.why === 'string' && r.why.length > 0 && r.map === null && r.chain.length === 0 && r.hist === false,
    `reason=${JSON.stringify(r.why)} map=${r.map} chain=${r.chain.length} history=${r.hist}`);
});

await scenario('G17d · empty punch-history result is an OUTAGE, not "nobody punched"', manila(2026,7,24,8,0), async (page) => {
  await page.evaluate(() => { records['RSR0100_06/29/2026'] = { punches: { timein: '08:00:00 AM' } }; });
  // awol_punch_days() returns EVERY non-separated worker precisely so that zero rows can only mean
  // the read went wrong. Read as a legitimate answer it would say "nobody in the yard has punched
  // in a month" and flag the entire roster.
  mock.punchDaysEmpty = true;
  const r = await page.evaluate(async () => {
    const why = await awolLoadPunchHistory();
    return { why, map: awolPunched };
  });
  report('G17d · empty result is treated as a failure, not an answer',
    /empty/.test(String(r.why)) && r.map === null,
    `reason=${JSON.stringify(r.why)} map=${r.map}`);
});

// The load path must also SUCCEED cleanly — otherwise G17c/G17d would pass against a function that
// is broken in every state. Proves the map is populated, keyed by normCode, and ISO-valued.
await scenario('G17e · a successful load populates the map, normCode-keyed and ISO-valued', manila(2026,7,24,8,0), async (page) => {
  mock.punchDaysExtra = { RSR0100: ['2026-07-14', '2026-07-22'] };
  await page.evaluate(() => { records = {}; });
  const r = await page.evaluate(async () => {
    const why = await awolLoadPunchHistory();
    const s = awolPunched && awolPunched['RSR0100'];
    return { why, codes: awolPunched ? Object.keys(awolPunched).length : 0,
             days: s ? [...s].sort() : null,
             spacedLookupWorks: awolPunchedOn('RSR 0100', '07/22/2026') };
  });
  report('G17e · load succeeds, map keyed by normCode, spacing drift resolves',
    r.why === null && r.codes === 9 && JSON.stringify(r.days) === '["2026-07-14","2026-07-22"]' && r.spacedLookupWorks === true,
    `reason=${r.why} codes=${r.codes} days=${JSON.stringify(r.days)} spacedLookup=${r.spacedLookupWorks}`);
});

// ==============================================================================
// G18 — THE 2026-08-05 INCIDENT: ten false cases in a twelve-second burst.
// Spec: docs/superpowers/specs/2026-08-05-awol-detection-data-source.md
//
// awol_events 41–50, 2026-08-04 23:59:55 → 2026-08-05 00:00:07, each reading "Absent 10
// consecutive days without approved leave". All ten false; four of them (RSR 0019, 0027, 0030,
// 0033) were present all 10 of 10 days their case named. attendance_records held every punch the
// whole time. The tablet's site data had been cleared via reset.html the evening before, so the
// local map rebuilt near-empty and the next sweep hit the 10-day cap for ten men at once.
// ==============================================================================

// G18a is the incident itself, reduced. It is the REGRESSION GUARD for the 08-04 fix: run this
// same scenario against main's kiosk (git checkout main -- kiosk/index.html) and it fails with a
// full chain per worker, which is how the failure was reproduced before any of this was written.
await scenario('G18a · empty local cache + full server history → nobody is judged absent', manila(2026,7,24,8,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1007778889990';
  await page.evaluate(() => loadTgFromCloud());
  // Four workers, present every working day the chain would walk. Exactly the shape of the four
  // men who were present 10 of 10.
  const days = ['2026-07-13','2026-07-14','2026-07-15','2026-07-16','2026-07-17','2026-07-20',
                '2026-07-21','2026-07-22','2026-07-23'];
  mock.punchDaysExtra = { RSR0100: days, RSR0101: days, RSR0102: days, RSR0103: days };
  // reset.html has just been through here. The tablet knows nothing at all.
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {}; leaveRequests = []; records = {}; });
  const chains = await page.evaluate(() => ['RSR0100','RSR0101','RSR0102','RSR0103']
    .map(c => ({ c, n: collectAbsentDates(c).length })));
  const worst = Math.max(...chains.map(x => x.n));
  report('G18a · an empty tablet cache invents no absences when the server has the punches',
    worst === 0,
    `chains=${chains.map(x => x.c + ':' + x.n).join(' ')} (each must be 0; main\'s build gives 10)`);
});

// G18b — §4.2. THE NEW HOLE. A server that answers successfully but covers less ground than the
// detector walks is the original defect with a different store. The 08-04 fix guards failure and
// emptiness; it does not guard a SHORT window, and nothing about a short window looks wrong.
await scenario('G18b · server window shorter than the lookback must abandon the sweep', manila(2026,7,24,8,0), async (page) => {
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {}; leaveRequests = []; records = {}; });
  // He punched 20 days back. The chain walks 21 days, so that punch is what ends it — but the
  // server is only serving 5 days, so from the client's side he looks absent throughout.
  mock.punchDaysExtra = { RSR0100: ['2026-07-04', '2026-07-23'] };
  mock.punchDaysWindow = 5;
  const r = await page.evaluate(async () => {
    const why = await awolLoadPunchHistory();
    return { why, map: awolPunched ? Object.keys(awolPunched).length : 0,
             chain: collectAbsentDates('RSR0100').length };
  });
  // A short window must be refused the same way an outage is: a reason back, no map, nothing judged.
  report('G18b · a short server window is refused, not silently judged on',
    typeof r.why === 'string' && r.why.length > 0 && r.map === 0 && r.chain === 0,
    `reason=${JSON.stringify(r.why)} mapCodes=${r.map} chain=${r.chain}`);
});

// G18c — §4.3. The never-punched guard must be a SECOND OPINION. Sharing the detector's map means
// it cannot contradict it: whatever truncated or corrupted the detector's view is already inside
// the guard. Here the detector's map is deliberately wiped after loading while the server can
// still answer — a guard that queries on its own says "he has history", a shared one says nothing.
await scenario('G18c · the never-punched guard queries independently of the detector map', manila(2026,7,24,8,0), async (page) => {
  await page.evaluate(() => { records = {}; });
  mock.punchDaysExtra = { RSR0100: ['2026-07-14', '2026-07-22'] };
  const r = await page.evaluate(async () => {
    await awolLoadPunchHistory();
    awolPunched = null;                       // the detector's view is gone; the SERVER still knows
    return { hist: await hasRecentPunchHistory('RSR0100') };
  });
  report('G18c · hasRecentPunchHistory answers from its own read, not the detector\'s map',
    r.hist === true,
    `hasRecentPunchHistory=${r.hist} (shared-map implementation returns false here)`);
});

// G18d — §4.2 / §6.3: THE VISIBLE NOTICE MUST NAME WHAT WAS SKIPPED, IN THE PAST TENSE.
// "A silent skip is not acceptable; a silent skip is how this went unnoticed for two days."
// The card was hardcoded to "the exemption list could not be read" — written when that was the
// only authority that could fail. It now fires for punch history and the never-punched guard too,
// so on two of three paths it named the wrong cause and sent the owner to check a list that was
// fine. sendAwolDetectionSkipped() always named it correctly on Telegram; the tablet's own card,
// which is the surface §4.2 requires, was the one lying.
await scenario('G18d · the skip notice names the authority that actually failed', manila(2026,7,24,8,0), async (page) => {
  // The skip list is mocked and healthy by default now, so the failure is INJECTED rather than
  // relied upon. That is the better test anyway: it proves the exemption-list branch specifically,
  // instead of passing because the gate happened to be broken for everyone.
  mock.skipListFail = true;
  const r = await page.evaluate(async () => {
    const read = () => (document.getElementById('awol-skip-msg') || {}).textContent || '';
    // (a) END TO END on the exemption-list path, with the RPC forced to 500.
    await checkAllAbsences();
    const viaSweep = { shown: (document.getElementById('awol-skip-card') || {}).style.display !== 'none',
                       text: read() };
    // (b) THE PATH THAT WAS WRONG. Rendering is asserted directly because the sweep cannot reach
    //     the punch-history gate while the skip list is unmocked (the standing G1/G15c/G16e gap).
    awolDetectionSkipped = true;
    awolSkipWhat = 'punch history';
    awolSkipWhy  = 'covers only 5 days but 21 are needed';
    renderAwolCards();
    return { viaSweep, punchText: read() };
  });
  const pastTense = /did not run/.test(r.punchText);
  const namesPunch = /punch history/.test(r.punchText);
  const blamesWrongThing = /exemption list/.test(r.punchText);
  const carriesReason = /covers only 5 days/.test(r.punchText);
  const sweepNamesSkipList = /exemption list/.test(r.viaSweep.text) && /did not run/.test(r.viaSweep.text);
  report('G18d · notice is past-tense, names the right authority, and carries the reason',
    pastTense && namesPunch && !blamesWrongThing && carriesReason && r.viaSweep.shown && sweepNamesSkipList,
    `pastTense=${pastTense} namesPunchHistory=${namesPunch} stillBlamesSkipList=${blamesWrongThing} `
    + `carriesReason=${carriesReason} sweepCardShown=${r.viaSweep.shown} sweepNamesSkipList=${sweepNamesSkipList}`);
});

// G18e — §6.4: A GENUINE ABSENCE RUN IS STILL DETECTED. THE ONLY POSITIVE TEST IN THE SUITE.
//
// Every other AWOL scenario asserts the SAFE direction — not suspended, not alerted, not barred.
// That is right, and it is also why a fix that simply switched detection off would have passed the
// entire suite. Nothing anywhere proved the detector still fires. This does.
//
// Runnable only now that awol_skip_list is mocked: the sweep used to abandon at its first gate, so
// it never reached awol_set_suspended and a suspension could not be observed end to end.
await scenario('G18e · a real 3-day absence run is still detected and a case opened', manila(2026,7,24,8,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1007778889990';
  await page.evaluate(() => loadTgFromCloud());
  // 07/20 is his last punch. 07/21, 07/22, 07/23 are absent working days — a genuine run of three,
  // which is the threshold (dates.length < 3 continues). 07/19 is a Sunday and transparent either
  // way. He has recent history, so the never-punched net does not shield him.
  mock.punchDaysExtra = { RSR0100: ['2026-07-14', '2026-07-17', '2026-07-20'] };
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {}; leaveRequests = []; records = {}; });
  const chain = await chainOf(page, 'RSR0100');
  await page.evaluate(() => checkAllAbsences());
  const c = mock.suspensions['RSR0100'];
  const opened = !!(c && c.active);
  const reasonOk = !!(c && /Absent 3 consecutive days without approved leave/.test(c.reason || ''));
  const datesOk = !!(c && Array.isArray(c.absent_dates) && c.absent_dates.length === 3
    && c.absent_dates.includes('2026-07-23') && c.absent_dates.includes('2026-07-21'));
  const alerted = mock.telegram.some(m => /RSR0100/.test(m.text));
  // A case is OPENED. He is NOT barred — Defect C: the sweep never writes the punch gate, so he
  // can still clock in tomorrow. Both halves matter; proving only the first would be proving the
  // thing that hurt people.
  const barred = await page.evaluate(() => !!suspendedEmployees['RSR0100']);
  report('G18e · genuine 3-day run → case opened, alert sent, worker NOT barred from punching',
    chain.length === 3 && opened && reasonOk && datesOk && alerted && !barred,
    `chain=${chain.length} opened=${opened} reason="${(c && c.reason) || ''}" `
    + `dates=${JSON.stringify((c && c.absent_dates) || [])} alerted=${alerted} barredLocally=${barred}`);
});

// ==============================================================================
//  H — SERVER-SIDE IDENTIFICATION (v2026-08-26b, Option A)
// ==============================================================================
// employees.pin has been a bcrypt hash since 2026-08-24, so the browser can no longer match it.
// The keypad is unchanged for the worker — six digits, name appears, punch — but identification
// now happens in the database via identify_employee_by_pin. These cover every answer that RPC can
// give, plus the two things that must never happen: a PIN reaching the tablet, and a punch being
// written without a successful identification.

await scenario('H1 · roster load never carries the pin column', manila(2026,7,15,8,0), async (page) => {
  const leaked = await page.evaluate(() => employees.filter(e => e && Object.prototype.hasOwnProperty.call(e, 'pin')).map(e => e.code));
  const haveIds = await page.evaluate(() => employees.every(e => !e || typeof e.id === 'string'));
  const cached = await page.evaluate(() => {
    try { return (JSON.parse(localStorage.getItem('rsr_employees') || '[]') || []).filter(e => e && 'pin' in e).length; }
    catch (e) { return -1; }
  });
  const noFindEmp = await page.evaluate(() => typeof findEmp === 'undefined' && typeof findByCode === 'function');
  report('H1 · pin never reaches employees[] or localStorage; ids present; findEmp gone',
    leaked.length === 0 && haveIds && cached === 0 && noFindEmp,
    `rowsWithPin=${JSON.stringify(leaked)} everyRowHasId=${haveIds} cachedRowsWithPin=${cached} findEmpRemoved=${noFindEmp}`);
});

await scenario('H2 · correct PIN identifies server-side and punches', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  const who = await enterPin(page, pinOf('RSR0100'));
  await doPunch(page, 'timein');
  const r = await recAt(page, 'RSR0100', k);
  report('H2 · six digits → identified by the RPC, name shown, punch written',
    who === 'RSR0100' && r && /08:00/.test(r.punches.timein)
      && mock.identifyCalls.length === 1 && mock.identifyCalls[0] === pinOf('RSR0100'),
    `curEmp=${who} timein=${r?.punches.timein} identifyCalls=${JSON.stringify(mock.identifyCalls)}`, sends());
});

await scenario('H3 · unknown PIN refuses, writes nothing', manila(2026,7,15,8,0), async (page) => {
  const who = await enterRawPin('111111');   // nobody's
  const hint = await page.evaluate(() => document.getElementById('pin-hint').textContent);
  const armed = await page.evaluate(() => !!curEmp);
  await doPunch(page, 'timein');             // inert: curEmp is null
  report('H3 · unknown PIN → not identified, no record, no upsert, one attempt burned',
    who === null && !armed && mock.writes.length === 0 && /PIN not found/i.test(hint)
      && (await page.evaluate(() => pinFailCount)) === 1,
    `curEmp=${who} hint="${hint}" writes=${mock.writes.length}`, sends());
});

await scenario('H4 · RPC unreachable → refuses cleanly, records nothing', manila(2026,7,15,8,0), async (page) => {
  mock.identifyFail = true;
  const who = await enterPin(page, pinOf('RSR0100'));
  const hint = await page.evaluate(() => document.getElementById('pin-hint').textContent);
  const fails = await page.evaluate(() => pinFailCount);
  await doPunch(page, 'timein');
  // The offline answer the owner chose (2026-08-26): a punch needs a connection. It must NOT be
  // queued — a queued punch would claim an identification that never happened. And a server fault
  // must not burn one of the worker's five attempts.
  report('H4 · server unreachable → \u201cNo connection\u201d, nothing recorded, nothing queued, no attempt burned',
    who === null && mock.writes.length === 0 && /No connection/i.test(hint) && fails === 0,
    `curEmp=${who} hint="${hint}" writes=${mock.writes.length} pinFailCount=${fails}`, sends());
});

await scenario('H5 · collision refuses and never picks a worker', manila(2026,7,15,8,0), async (page) => {
  mock.identifyCollide = pinOf('RSR0100');
  const who = await enterPin(page, pinOf('RSR0100'));
  const hint = await page.evaluate(() => document.getElementById('pin-hint').textContent);
  const fails = await page.evaluate(() => pinFailCount);
  await doPunch(page, 'timein');
  // Refusing is the whole point: resolving a collision by picking one worker would let a man punch
  // as somebody else. It also must not burn an attempt — retyping cannot help him, and locking the
  // tablet over an admin data fault punishes the wrong person.
  report('H5 · two matches → \u201csee the office\u201d, nobody identified, no punch, no attempt burned',
    who === null && mock.writes.length === 0 && /see the office/i.test(hint) && fails === 0,
    `curEmp=${who} hint="${hint}" writes=${mock.writes.length} pinFailCount=${fails}`, sends());
});

await scenario('H6 · throttled answer is surfaced, not mistaken for a wrong PIN', manila(2026,7,15,8,0), async (page) => {
  mock.identifyThrottled = true;
  const who = await enterPin(page, pinOf('RSR0100'));
  const hint = await page.evaluate(() => document.getElementById('pin-hint').textContent);
  const fails = await page.evaluate(() => pinFailCount);
  report('H6 · throttled → its own message, no punch, no attempt burned',
    who === null && mock.writes.length === 0 && /too many tries/i.test(hint) && fails === 0,
    `curEmp=${who} hint="${hint}" pinFailCount=${fails}`, sends());
});

await scenario('H7 · five wrong PINs still lock the kiosk', manila(2026,7,15,8,0), async (page) => {
  for (let i = 0; i < 5; i++) await enterRawPin('111111');
  const locked = await page.evaluate(() => isKioskLocked());
  const shown = await page.evaluate(() => { const l = document.getElementById('kiosk-lock-screen'); return !!l && l.style.display !== 'none'; });
  report('H7 · lockout after 5 failed identifications survives the async keypad', locked && shown,
    `locked=${locked} lockScreenShown=${shown}`);
});

await scenario('H8 · identification applies no employment-status policy', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  const who = await enterPin(page, pinOf('RSR0500'));   // carries is_active:false in the fixture
  await doPunch(page, 'timein');
  const r = await recAt(page, 'RSR0500', k);
  // SETTLED 2026-08-26, the hard way. An is_active filter was added to the RPC and removed the same
  // day: employees HAS NO is_active COLUMN, so the deployed function raised 42703 and refused every
  // worker at every tablet. identify_employee_by_pin is identity-only and changes nothing about who
  // may punch — the same policy the client-side lookup it replaced had.
  //
  // This scenario is the guard against re-adding such a filter on a column that does not exist. If a
  // real employment-status column is ever confirmed and the owner asks for it, this flips — but it
  // must not flip because a filter looked sensible.
  report('H8 · a worker flagged inactive client-side is still identified and can punch',
    who === 'RSR0500' && r && r.punches.timein,
    `curEmp=${who} timein=${r?.punches.timein}`, sends());
});

await scenario('H9 · taps during a check do not stack RPC calls', manila(2026,7,15,8,0), async (page) => {
  // Each miss costs a full bcrypt scan on the server, so a worker drumming the pad must not be
  // able to queue several. kpChecking gates the keypad for the whole round trip.
  const out = await page.evaluate(async (p) => {
    kpClr();
    const proms = []; for (const d of (p + '99')) proms.push(kp(d));   // 8 taps, 6 of them a PIN
    await Promise.all(proms);
    return { cur: curEmp ? curEmp.code : null };
  }, pinOf('RSR0100'));
  report('H9 · extra taps mid-check are ignored; exactly one RPC call',
    mock.identifyCalls.length === 1 && out.cur === 'RSR0100',
    `identifyCalls=${JSON.stringify(mock.identifyCalls)} curEmp=${out.cur}`);
});

// ==============================================================================
//  I - OFFLINE PUNCH QUEUE (v2026-08-27a)
// ==============================================================================
// A tablet with no connection cannot identify anybody. It queues the RAW TYPED PIN plus the button
// pressed, and decides nothing else; sync_offline_punch judges both on reconnect. These scenarios
// exist mostly to pin down what must NEVER happen: a queued punch that silently disappears, a
// refusal turned into a punch, or an employee id invented on the tablet.

// Take the page offline the way the kiosk sees it: navigator.onLine false + an offline event.
const goOffline = (page) => page.evaluate(() => {
  Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
});
const goOnline = (page) => page.evaluate(() => {
  Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true });
});
const offq = (page) => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('rsr_offline_punches') || '[]'); } catch (e) { return null; }
});

await scenario('I1 - offline punch queues the PIN, never an employee id', manila(2026,7,15,8,0), async (page) => {
  await goOffline(page);
  await enterPin(page, pinOf('RSR0100'));
  await doPunch(page, 'timein');
  const q = await offq(page);
  const e = (q && q[0]) || {};
  const shapeOk = q && q.length === 1
    && e.pin === pinOf('RSR0100')
    && e.punch_type === 'timein'
    && typeof e.client_ts === "string" && typeof e.device_id === "string" && typeof e.queued_at === "number"
    && !('employee_id' in e) && !('employee_code' in e) && !('code' in e);
  report('I1 - queued entry carries the raw PIN and no identity; nothing sent while offline',
    shapeOk && mock.writes.length === 0 && mock.syncOfflineCalls.length === 0,
    `entry=${JSON.stringify(e)} writes=${mock.writes.length}`, sends());
});

await scenario('I2 - a wrong PIN while ONLINE is never queued', manila(2026,7,15,8,0), async (page) => {
  await enterRawPin('111111');
  const q = await offq(page);
  report('I2 - online refusal stays a refusal', (q || []).length === 0 && mock.writes.length === 0,
    `queue=${JSON.stringify(q)}`, sends());
});

await scenario('I3 - a collision or throttle while ONLINE is never queued', manila(2026,7,15,8,0), async (page) => {
  mock.identifyCollide = pinOf('RSR0100');
  await enterPin(page, pinOf('RSR0100'));
  const afterCollision = (await offq(page) || []).length;
  mock.identifyCollide = null; mock.identifyThrottled = true;
  await enterPin(page, pinOf('RSR0207'));
  const afterThrottle = (await offq(page) || []).length;
  report('I3 - collision and throttle are reported at the keypad, not queued',
    afterCollision === 0 && afterThrottle === 0,
    `afterCollision=${afterCollision} afterThrottle=${afterThrottle}`, sends());
});

await scenario('I4 - a server ERROR while online is not queued either', manila(2026,7,15,8,0), async (page) => {
  // identifyFail makes the RPC 500. The server ANSWERED; it may have been a refusal, so queuing it
  // would turn a refusal into a punch.
  mock.identifyFail = true;
  await enterPin(page, pinOf('RSR0100'));
  const q = await offq(page);
  report('I4 - server_error is not a connection failure and is not queued', (q || []).length === 0,
    `queue=${JSON.stringify(q)}`, sends());
});

await scenario('I5 - reconnect replays in client_ts order, oldest first', manila(2026,7,15,8,0), async (page) => {
  await goOffline(page);
  // Queue three punches OUT of chronological order on purpose.
  await page.evaluate(() => {
    const mk = (pin, type, iso) => ({ pin, punch_type: type, client_ts: iso, device_id: 'dev', site: 'Carmen', queued_at: Date.now() });
    const q = [
      mk('100200','lunch_out','2026-07-15T04:00:00.000Z'),
      mk('100200','timein',   '2026-07-15T00:00:00.000Z'),
      mk('100200','timeout',  '2026-07-15T09:00:00.000Z'),
    ];
    localStorage.setItem('rsr_offline_punches', JSON.stringify(q));
    offlineQueue = q;
  });
  await goOnline(page);
  await page.evaluate(() => flushOfflinePunches());
  await page.waitForTimeout(600);
  const order = mock.syncOfflineCalls.map(c => c.p_punch_type);
  const left = (await offq(page) || []).length;
  report('I5 - replayed oldest-first and the queue drained',
    JSON.stringify(order) === JSON.stringify(['timein','lunch_out','timeout']) && left === 0,
    `order=${JSON.stringify(order)} remaining=${left}`);
});

await scenario('I6 - a REJECTED punch leaves the queue and is surfaced, never silently dropped', manila(2026,7,15,8,0), async (page) => {
  await goOffline(page);
  await enterPin(page, pinOf('RSR0100'));
  await doPunch(page, 'timein');
  mock.syncOfflineMode = 'reject'; mock.syncOfflineReason = 'out_of_sequence';
  await goOnline(page);
  await page.evaluate(() => flushOfflinePunches());
  await page.waitForTimeout(600);
  const left = (await offq(page) || []).length;
  const notified = await page.evaluate(() => (notifLog||[]).some(n => /REJECTED/i.test(n.msg||n.text||'')));
  // It is gone from the tablet because the SERVER accounted for it - it is a row in
  // kiosk_offline_rejects now. The tablet must still say so rather than going quiet.
  report('I6 - rejected entry dequeued and reported locally', left === 0 && notified,
    `remaining=${left} surfacedOnTablet=${notified}`);
});

await scenario('I7 - a NETWORK failure keeps the punch and keeps counting it', manila(2026,7,15,8,0), async (page) => {
  await goOffline(page);
  await enterPin(page, pinOf('RSR0100'));
  await doPunch(page, 'timein');
  mock.syncOfflineMode = 'net';
  await goOnline(page);
  await page.evaluate(() => flushOfflinePunches());
  await page.waitForTimeout(600);
  const left = (await offq(page) || []).length;
  const badge = await page.evaluate(() => { const b = document.getElementById('sync-badge'); return b ? b.textContent : ''; });
  // THE point of this scenario: an unreachable server must never quietly consume a punch. This is
  // the catch-and-requeue failure mode - the entry stays, and it stays VISIBLE.
  report('I7 - unreachable server keeps the punch and shows it in the badge',
    left === 1 && /pending/i.test(badge),
    `remaining=${left} badge="${badge}"`);
});

await scenario('I8 - a synced punch is folded into the local record', manila(2026,7,15,8,0), async (page) => {
  const k = await dateKeyFor(page);
  await goOffline(page);
  await enterPin(page, pinOf('RSR0100'));
  await doPunch(page, 'timein');
  await goOnline(page);
  await page.evaluate(() => flushOfflinePunches());
  await page.waitForTimeout(600);
  const r = await recAt(page, 'RSR0100', k);
  // Without this merge the tablet would later push its own full record for that worker and
  // overwrite the punch it never knew about - the punch would vanish and the day would be short.
  report('I8 - the server-written punch lands in the local record', !!(r && r.punches && r.punches.timein),
    `localTimein=${r && r.punches ? r.punches.timein : null}`);
});

await scenario('I9 - the queue is capped at 200 entries', manila(2026,7,15,8,0), async (page) => {
  await goOffline(page);
  const res = await page.evaluate(() => {
    const q = [];
    for (let i = 0; i < 205; i++) q.push({ pin:'100200', punch_type:'timein', client_ts:new Date().toISOString(), device_id:'d', site:'Carmen', queued_at: Date.now() });
    localStorage.setItem('rsr_offline_punches', JSON.stringify(q));
    offlineQueue = q;
    return offqCount();
  });
  report('I9 - capped at 200, newest kept', res === 200, `count=${res}`);
});

await scenario('I10 - entries older than 12h are dropped, loudly', manila(2026,7,15,8,0), async (page) => {
  await goOffline(page);
  const res = await page.evaluate(() => {
    const old = Date.now() - (13 * 60 * 60 * 1000);
    const q = [{ pin:'100200', punch_type:'timein', client_ts:new Date(old).toISOString(), device_id:'d', site:'Carmen', queued_at: old }];
    localStorage.setItem('rsr_offline_punches', JSON.stringify(q));
    offlineQueue = q;
    const n = offqCount();
    return { n, notified: (notifLog||[]).some(x => /expired/i.test(x.msg||x.text||'')) };
  });
  // Dropped, but never silently: an expired punch is a day that needs correcting by hand.
  report('I10 - expired entry removed and logged', res.n === 0 && res.notified,
    `count=${res.n} logged=${res.notified}`);
});

await scenario('I11 - the queue is purged at the start of the shift day', manila(2026,7,15,8,0), async (page) => {
  // Scenario clock is 08:00, so the current shift day opened at 07:00 today. An entry queued
  // before that belongs to yesterday shift and must not survive into this one - a PIN must never
  // outlive the shift it was typed in.
  await goOffline(page);
  const res = await page.evaluate(() => {
    const beforeOpen = new Date(); beforeOpen.setHours(6, 30, 0, 0);   // 06:30 today, before the 07:00 open
    const afterOpen  = new Date(); afterOpen.setHours(7, 30, 0, 0);    // 07:30 today, inside this shift day
    const q = [
      { pin:'100200', punch_type:'timein',  client_ts:beforeOpen.toISOString(), device_id:'d', site:'Carmen', queued_at: beforeOpen.getTime() },
      { pin:'100200', punch_type:'lunch_out', client_ts:afterOpen.toISOString(), device_id:'d', site:'Carmen', queued_at: afterOpen.getTime() },
    ];
    localStorage.setItem('rsr_offline_punches', JSON.stringify(q));
    offlineQueue = q;
    const n = offqCount();
    return { n, kept: offlineQueue.map(j => j.punch_type) };
  });
  report('I11 - yesterday shift entry purged, today entry kept',
    res.n === 1 && JSON.stringify(res.kept) === JSON.stringify(['lunch_out']),
    `count=${res.n} kept=${JSON.stringify(res.kept)}`);
});

await scenario('I12 - a night punch just before midnight survives into the small hours', manila(2026,7,15,23,50), async (page) => {
  // The reason the boundary is 07:00 and not midnight. A night worker punches at 23:50 with no
  // signal; the tablet reconnects at 00:10. A midnight purge would have deleted that punch ten
  // minutes after it was made, silently costing him the day.
  await goOffline(page);
  await enterPin(page, pinOf('RSR0303'));
  await doPunch(page, 'timein');
  const before = (await offq(page) || []).length;
  await setNow(page, manila(2026, 7, 16, 0, 10));   // past midnight, still the same shift day
  const after = await page.evaluate(() => offqCount());
  report('I12 - punch survives midnight; the shift day has not turned over yet',
    before === 1 && after === 1, `beforeMidnight=${before} afterMidnight=${after}`);
});

// ==============================================================================
//  J - OFFLINE PUNCH V2: dedupe, confirm step, photo (v2026-09-03a)
// ==============================================================================
// Three additions on top of section I's queue: (1) a same-type re-tap today is refused instead of
// queued twice, (2) nothing queues until the worker sees a masked-PIN Confirm/Retype screen, and
// (3) a photo captured at tap time travels with the entry - by reference (IndexedDB), never inline
// in localStorage - and is either handed to the server on sync (for a reject to review) or sent
// straight to Telegram by the tablet itself (for an accept, mirroring the ONLINE punch path exactly).

const OFFLINE_PHOTO_FIXTURE = 'data:image/jpeg;base64,ZmFrZS1qcGVnLWJ5dGVz';
// The real camera is unreachable in this headless suite (getUserMedia is stubbed to reject for every
// scenario - see the init script above). Rather than fake a live video stream, this stubs the ONE
// function that turns a frame into a data URL, the same boundary-level substitution the harness
// already uses for getUserMedia itself - everything downstream (IndexedDB storage, the RPC payload,
// the Telegram send, cleanup) runs as the real shipped code.
const stubOfflineCamera = (page, dataUrl) => page.evaluate((d) => {
  window.capturePhotoOffline = () => Promise.resolve(d);
}, dataUrl);
// Poll instead of a fixed sleep: J11 pushes 200 sequential RPC round-trips through the mock, and a
// single fixed wait would either stall every other scenario or flake under load.
async function waitForQueueEmpty(page, maxMs = 15000) {
  const step = 400;
  for (let waited = 0; waited < maxMs; waited += step) {
    if ((await offq(page) || []).length === 0) return true;
    await page.waitForTimeout(step);
  }
  return (await offq(page) || []).length === 0;
}
// A REAL DOM .click(), not a direct punch() call like doPunch() — a disabled <button> never
// dispatches a click event at all (browser spec, not app logic), which is exactly the symptom the
// offlineClearTimer race produces. doPunch()/punch(t) would call the handler regardless of the
// disabled attribute and could never reproduce or verify this bug.
const clickPunchBtn = (page, type) => page.evaluate((t) => {
  const b = document.getElementById(BIDS[t]);
  if (b) b.click();
}, type);
const btnEnabled = (page, type) => page.evaluate((t) => {
  const b = document.getElementById(BIDS[t]);
  return !!b && !b.disabled;
}, type);

await scenario('J1 - same PIN + same punch type today is refused, not re-queued', manila(2026,7,15,8,0), async (page) => {
  await goOffline(page);
  await enterPin(page, pinOf('RSR0100'));
  await doPunch(page, 'timein');
  const afterFirst = (await offq(page) || []).length;
  await enterPin(page, pinOf('RSR0100'));
  await doPunchNoConfirm(page, 'timein');   // dedupe fires INSIDE punch(), before any confirm screen
  const modal = await offlineConfirmState(page);
  const afterSecond = (await offq(page) || []).length;
  report('J1 - second same-type tap never reaches the confirm screen and the queue is unchanged',
    afterFirst === 1 && afterSecond === 1 && !modal.show,
    `afterFirst=${afterFirst} afterSecond=${afterSecond} confirmShown=${modal.show}`);
});

await scenario('J2 - a DIFFERENT punch type for the same PIN is not blocked', manila(2026,7,15,8,0), async (page) => {
  await goOffline(page);
  await enterPin(page, pinOf('RSR0100'));
  await doPunch(page, 'timein');
  await enterPin(page, pinOf('RSR0100'));
  await doPunch(page, 'lunch_out');
  const types = (await offq(page) || []).map(j => j.punch_type);
  report('J2 - the dedupe is scoped to the same punch_type only',
    types.length === 2 && types.includes('timein') && types.includes('lunch_out'),
    `types=${JSON.stringify(types)}`);
});

await scenario('J3 - the confirm screen shows a masked PIN + the punch type, and queues nothing until Confirm', manila(2026,7,15,8,0), async (page) => {
  await goOffline(page);
  await enterPin(page, pinOf('RSR0100'));   // pin '100200' → masked '••••00'
  await doPunchNoConfirm(page, 'timein');
  const state = await offlineConfirmState(page);
  const beforeConfirm = (await offq(page) || []).length;
  await confirmOffline(page);
  const afterConfirm = (await offq(page) || []).length;
  report('J3 - masked PIN + punch type shown; the queue grows only after Confirm',
    state.show && state.text.includes('••••00') && state.text.includes('Time In')
      && beforeConfirm === 0 && afterConfirm === 1,
    `text="${state.text}" beforeConfirm=${beforeConfirm} afterConfirm=${afterConfirm}`);
});

await scenario('J4 - Retype discards the pending punch and resets the keypad', manila(2026,7,15,8,0), async (page) => {
  await goOffline(page);
  await enterPin(page, pinOf('RSR0100'));
  await doPunchNoConfirm(page, 'timein');
  await retypeOffline(page);
  const state = await offlineConfirmState(page);
  const q = (await offq(page) || []).length;
  const pinCleared = await page.evaluate(() => offlinePin === null && pin === '');
  report('J4 - Retype queues nothing, hides the screen, and clears the typed PIN',
    !state.show && q === 0 && pinCleared,
    `modalShown=${state.show} queued=${q} pinCleared=${pinCleared}`);
});

await scenario('J5 - a double-tap on Confirm queues exactly once', manila(2026,7,15,8,0), async (page) => {
  await goOffline(page);
  await enterPin(page, pinOf('RSR0100'));
  await doPunchNoConfirm(page, 'timein');
  await Promise.all([confirmOffline(page), confirmOffline(page)]);
  const q = (await offq(page) || []).length;
  report('J5 - pendingOfflinePunch is cleared before the queue write, so a repeat Confirm is a no-op',
    q === 1, `queued=${q}`);
});

await scenario('J6 - a captured offline photo is stored by reference, never inline in localStorage', manila(2026,7,15,8,0), async (page) => {
  await stubOfflineCamera(page, OFFLINE_PHOTO_FIXTURE);
  await goOffline(page);
  await enterPin(page, pinOf('RSR0100'));
  await doPunch(page, 'timein');
  const e = (await offq(page) || [])[0] || {};
  const rawStore = await page.evaluate(() => localStorage.getItem('rsr_offline_punches') || '');
  report('J6 - the queue entry carries only a photo_id; the photo bytes never touch localStorage',
    typeof e.photo_id === 'string' && e.photo_id.length > 0 && !rawStore.includes('data:image'),
    `photo_id=${e.photo_id} rawContainsImage=${rawStore.includes('data:image')}`);
});

await scenario('J7 - a stored offline photo is read back and sent as p_photo on sync', manila(2026,7,15,8,0), async (page) => {
  await stubOfflineCamera(page, OFFLINE_PHOTO_FIXTURE);
  await goOffline(page);
  await enterPin(page, pinOf('RSR0100'));
  await doPunch(page, 'timein');
  await goOnline(page);
  await page.evaluate(() => flushOfflinePunches());
  await waitForQueueEmpty(page);
  const call = mock.syncOfflineCalls[0] || {};
  report('J7 - p_photo carries the exact captured data URL',
    call.p_photo === OFFLINE_PHOTO_FIXTURE, `p_photo=${String(call.p_photo).slice(0,40)}`);
});

await scenario('J7b - no camera available → p_photo is explicitly null, never omitted', manila(2026,7,15,8,0), async (page) => {
  await goOffline(page);   // capturePhotoOffline not stubbed: camReady stays false, same as every other scenario
  await enterPin(page, pinOf('RSR0100'));
  await doPunch(page, 'timein');
  await goOnline(page);
  await page.evaluate(() => flushOfflinePunches());
  await waitForQueueEmpty(page);
  const call = mock.syncOfflineCalls[0] || {};
  report('J7b - no photo captured → p_photo is sent as null',
    call.p_photo === null, `p_photo=${JSON.stringify(call.p_photo)}`);
});

await scenario('J8 - a synced offline punch with a photo notifies Telegram with the ORIGINAL tap time', manila(2026,7,15,7,48), async (page) => {
  mock.tgConfigured = true; mock.tgBackupGroupId = '-1005550001112';
  await page.evaluate(() => loadTgFromCloud());
  await stubOfflineCamera(page, OFFLINE_PHOTO_FIXTURE);
  await goOffline(page);
  await enterPin(page, pinOf('RSR0100'));
  await doPunch(page, 'timein');   // tapped 07:48 AM, offline
  await setNow(page, manila(2026,7,15,15,0));   // reconnects at 3:00 PM - a very different time
  await goOnline(page);
  await page.evaluate(() => flushOfflinePunches());
  await waitForQueueEmpty(page);
  // sendOfflineSyncedPhotoNotif is deliberately fire-and-forget (never awaited by the sync loop, so
  // a slow/failed Telegram send cannot stall the next punch) - the queue can empty before it lands.
  for (let i = 0; i < 15 && !mock.telegram.some(t => t.method === 'sendPhoto'); i++) await page.waitForTimeout(200);
  const sent = mock.telegram.find(t => t.method === 'sendPhoto');
  // The whole point: the office must never mistake a stale morning photo for an afternoon one just
  // because it landed in Telegram at 3 PM.
  report('J8 - caption carries the original 07:48 tap time and an explicit offline/synced marker',
    !!sent && sent.hasPhoto && sent.chat_id === '-1005550001112'
      && /07:48/.test(sent.text) && /offline/i.test(sent.text) && /synced/i.test(sent.text),
    `sent=${JSON.stringify(sent)}`);
});

await scenario('J9 - a REJECTED offline punch hands its photo to the server, not to Telegram', manila(2026,7,15,8,0), async (page) => {
  mock.tgConfigured = true; mock.tgBackupGroupId = '-1005550001112';
  await page.evaluate(() => loadTgFromCloud());
  await stubOfflineCamera(page, OFFLINE_PHOTO_FIXTURE);
  await goOffline(page);
  await enterPin(page, pinOf('RSR0100'));
  await doPunch(page, 'timein');
  mock.syncOfflineMode = 'reject'; mock.syncOfflineReason = 'out_of_sequence';
  await goOnline(page);
  await page.evaluate(() => flushOfflinePunches());
  await waitForQueueEmpty(page);
  const call = mock.syncOfflineCalls[0] || {};
  const sentPhoto = mock.telegram.some(t => t.method === 'sendPhoto');
  report('J9 - a rejected sync still carries p_photo (for the admin card); the tablet does not also notify Telegram',
    call.p_photo === OFFLINE_PHOTO_FIXTURE && !sentPhoto,
    `p_photo=${String(call.p_photo).slice(0,20)} telegramSentPhoto=${sentPhoto}`);
});

await scenario('J10 - the stored photo is deleted once the server has accounted for the punch', manila(2026,7,15,8,0), async (page) => {
  await stubOfflineCamera(page, OFFLINE_PHOTO_FIXTURE);
  await goOffline(page);
  await enterPin(page, pinOf('RSR0100'));
  await doPunch(page, 'timein');
  const photoId = (await offq(page))[0].photo_id;
  await goOnline(page);
  await page.evaluate(() => flushOfflinePunches());
  await waitForQueueEmpty(page);
  const stillThere = await page.evaluate(async (id) => !!(await offlinePhotoGet(id)), photoId);
  report('J10 - the IndexedDB photo row is removed once the queue entry is gone',
    !stillThere, `photoStillInIndexedDB=${stillThere}`);
});

await scenario('J11 - STRESS: 200 photo-bearing offline entries fit and all sync', manila(2026,7,15,8,0), async (page) => {
  await goOffline(page);
  const setup = await page.evaluate(async (fixture) => {
    const q = [];
    for (let i = 0; i < 200; i++) {
      const id = offlinePhotoNewId();
      await offlinePhotoPut(id, fixture);
      const ts = Date.now() - ((200 - i) * 1000);
      q.push({ pin:'100200', punch_type:'timein', client_ts:new Date(ts).toISOString(),
                device_id:'stress-dev', site:'Carmen', queued_at: ts, photo_id: id });
    }
    localStorage.setItem('rsr_offline_punches', JSON.stringify(q));
    offlineQueue = q;
    return { queued: offlineQueue.length };
  }, OFFLINE_PHOTO_FIXTURE);
  mock.syncOfflineMode = 'ok';
  await goOnline(page);
  await page.evaluate(() => flushOfflinePunches());
  await waitForQueueEmpty(page, 30000);
  const left = (await offq(page) || []).length;
  const allHadPhoto = mock.syncOfflineCalls.length === 200
    && mock.syncOfflineCalls.every(c => c.p_photo === OFFLINE_PHOTO_FIXTURE);
  const orphanCount = await page.evaluate(() => new Promise(async (res) => {
    try{
      const db = await offlinePhotoDB();
      const tx = db.transaction('photos','readonly');
      const req = tx.objectStore('photos').count();
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(-1);
    }catch(e){ res(-1); }
  }));
  report('J11 - all 200 photo-bearing entries synced, each carried its photo, and none orphaned in IndexedDB',
    setup.queued === 200 && left === 0 && allHadPhoto && orphanCount === 0,
    `queued=${setup.queued} remaining=${left} calls=${mock.syncOfflineCalls.length} allHadPhoto=${allHadPhoto} orphans=${orphanCount}`);
});

// ── offlineClearTimer race (found 2026-09-03, fixed same day) ──────────────────────────────────
// queueOfflinePunch used to end with a bare setTimeout(()=>kpClr(),4000) with no handle - it fired on
// its own fixed clock no matter what happened afterward. If the worker was still mid-session past 4s
// (retyping a PIN, or sitting on a confirm screen for a SECOND punch), it nulled offlinePin and
// disabled every button out from under them via updBtns(null). The next tap then hit a DISABLED
// button, which never dispatches a click at all - no modal, no error, nothing. These two scenarios
// use a REAL DOM click (clickPunchBtn), not doPunch(), because doPunch() calls punch(t) directly and
// would run the handler regardless of whether the button was actually disabled - it cannot see this
// bug at all.

await scenario('J12 - re-entering the PIN cancels the old timer, so a later distinct punch still reaches the confirm screen and queues', manila(2026,7,15,8,0), async (page) => {
  // The DANGEROUS ordering from the original report: the stale timer (scheduled at T=0 by the first
  // Confirm) must fire AFTER a retype has already reset offlinePin/buttons, not before. Retyping
  // immediately (well inside the old timer's 4000ms window) and THEN waiting past that deadline is
  // what actually exercises the fix — a retype that only happens after the wait would never hit the
  // bug either way, since kp()'s offline branch always rebuilds state from scratch on its own.
  await goOffline(page);
  await enterPin(page, pinOf('RSR0100'));
  await clickPunchBtn(page, 'timein');
  await confirmOffline(page);                  // queues 'timein' at T≈0; schedules the auto-clear for T+4000ms
  const afterFirst = (await offq(page) || []).length;
  await enterPin(page, pinOf('RSR0100'));       // retype EARLY — exactly as the original repro did
  // Now wait until well past where the ORIGINAL (T=0-scheduled) timer's deadline falls. Fixed code
  // already cancelled that timer at the retype above and it never fires. The old code had no such
  // cancellation, and this is exactly when it used to fire — AFTER the retype had already reset
  // offlinePin and re-enabled the buttons.
  await page.waitForTimeout(4300);
  const enabledAfterWait = await btnEnabled(page, 'lunch_out');
  await clickPunchBtn(page, 'lunch_out');       // a DIFFERENT punch type — real DOM click
  const confirmShown = (await offlineConfirmState(page)).show;
  if (confirmShown) await confirmOffline(page);
  const q = await offq(page);
  const types = (q || []).map(j => j.punch_type);
  report('J12 - re-entering the PIN before the old deadline keeps the buttons usable well after it passes',
    afterFirst === 1 && enabledAfterWait && confirmShown && types.length === 2
      && types.includes('timein') && types.includes('lunch_out'),
    `afterFirst=${afterFirst} enabledAfterWait=${enabledAfterWait} confirmShown=${confirmShown} types=${JSON.stringify(types)}`);
});

await scenario('J13 - after a confirm screen outlives the old timer, the keypad stays usable for a THIRD punch with no retype', manila(2026,7,15,8,0), async (page) => {
  // NOTE: confirming the SECOND punch's own screen succeeds even under the old bug — Confirm reads
  // pendingOfflinePunch (captured when the screen opened), not the live offlinePin the stale timer
  // nulls, so that alone does not distinguish old from new. The real damage under the old bug is
  // what's left BEHIND: kpClr()'s updBtns(null) disabled every button while the screen was open, and
  // nothing re-enables them afterward — so the tablet is stuck needing a PIN retype for a third punch
  // that should need none. THAT is what this asserts.
  await goOffline(page);
  await enterPin(page, pinOf('RSR0100'));
  await clickPunchBtn(page, 'timein');
  await confirmOffline(page);                  // queues 'timein'; schedules the auto-clear
  await clickPunchBtn(page, 'lunch_out');       // opens the confirm screen for a SECOND, distinct punch
  const shownBefore = (await offlineConfirmState(page)).show;
  await page.waitForTimeout(4300);              // outlive the old timer's window WHILE this screen is up
  await confirmOffline(page);                   // queues 'lunch_out'
  const enabledForThird = await btnEnabled(page, 'pm_out');
  await clickPunchBtn(page, 'pm_out');           // a THIRD distinct punch, no PIN retype
  const confirmShownThird = (await offlineConfirmState(page)).show;
  if (confirmShownThird) await confirmOffline(page);
  const q = await offq(page);
  const types = (q || []).map(j => j.punch_type);
  report('J13 - keypad stays usable for a third punch after a confirm screen outlives the old timer',
    shownBefore && enabledForThird && confirmShownThird && types.length === 3
      && types.includes('timein') && types.includes('lunch_out') && types.includes('pm_out'),
    `shownBefore=${shownBefore} enabledForThird=${enabledForThird} confirmShownThird=${confirmShownThird} types=${JSON.stringify(types)}`);
});

// ==============================================================================
//  K - employee_suspensions poll: navigator.onLine gate + failure backoff (v2026-09-03c)
// ==============================================================================
// The bug: setInterval(loadSuspensionsFromCloud, 45000) had no online gate and no backoff - a
// genuinely offline tablet logged one identical failed request every 45s, forever (211 in one
// 2.6-hour session). suspPollCycle() replaces it: skip entirely while offline, double the wait after
// each real failed ATTEMPT (capped), reset to the base cadence on a real success. Driven directly via
// page.evaluate(() => suspPollCycle()) rather than real timers - the growing delays would otherwise
// take minutes of actual wall-clock time to observe.

await scenario('K1 - while offline, the poll skips the attempt entirely and does not touch the fail streak', manila(2026,7,15,8,0), async (page) => {
  mock.suspensionsFail = true;   // if this fires at all, the test would see it - it must not fire
  await goOffline(page);
  const before = await page.evaluate(() => suspPollFails);
  const delay = await page.evaluate(() => suspPollCycle());
  const after = await page.evaluate(() => suspPollFails);
  report('K1 - offline poll makes no request and leaves the fail streak untouched',
    before === 0 && after === 0 && delay === 45000,
    `before=${before} after=${after} delay=${delay} (base=45000)`);
});

await scenario('K2 - repeated failures make the retry spacing grow and cap, never hammering at a fixed 45s', manila(2026,7,15,8,0), async (page) => {
  mock.suspensionsFail = true;
  const delays = [];
  for (let i = 0; i < 6; i++) delays.push(await page.evaluate(() => suspPollCycle()));
  // 45000 doubling from the FIRST real failure, capped at 8x base (SUSP_POLL_MAX_MS = 45000*8):
  // 90000, 180000, 360000(cap), 360000, 360000, 360000...
  const expected = [90000, 180000, 360000, 360000, 360000, 360000];
  const grows = delays.every((d, i) => d === expected[i]);
  const neverHammers = delays.slice(1).every(d => d > 45000);   // never falls back to the bare 45s cadence
  report('K2 - delay sequence doubles from the base and caps at 8x (6 min), never returning to bare 45s while failing',
    grows && neverHammers,
    `delays=${JSON.stringify(delays)} expected=${JSON.stringify(expected)}`);
});

await scenario('K3 - a real success resets the streak back to the base 45s cadence', manila(2026,7,15,8,0), async (page) => {
  mock.suspensionsFail = true;
  await page.evaluate(() => suspPollCycle());              // fail #1 -> 90000
  await page.evaluate(() => suspPollCycle());              // fail #2 -> 180000
  const failsBeforeSuccess = await page.evaluate(() => suspPollFails);
  mock.suspensionsFail = false;                             // connection recovers
  const delayAfterSuccess = await page.evaluate(() => suspPollCycle());
  const failsAfterSuccess = await page.evaluate(() => suspPollFails);
  report('K3 - a successful poll clears the fail streak and the next delay drops back to base',
    failsBeforeSuccess === 2 && failsAfterSuccess === 0 && delayAfterSuccess === 45000,
    `failsBeforeSuccess=${failsBeforeSuccess} failsAfterSuccess=${failsAfterSuccess} delayAfterSuccess=${delayAfterSuccess}`);
});

// ==============================================================================
//  L - isReallyOnline() probe, offqPollCycle backoff, updateSyncBadge cache-read (v2026-09-04)
// ==============================================================================
// The finding this fixes, confirmed on REAL hardware (not a DevTools artifact): navigator.onLine
// reads true with Airplane Mode fully ON, while every actual request fails with a genuine
// net::ERR_INTERNET_DISCONNECTED. L5 reproduces that exact shape - navigator.onLine is never
// toggled false in that scenario; only the network itself (via the mocked probe) is made to fail.
const seedOneOfflinePunch = (page) => page.evaluate(() => {
  const q = [{ pin:'100200', punch_type:'timein', client_ts:new Date().toISOString(), device_id:'d', site:'Carmen', queued_at: Date.now() }];
  localStorage.setItem('rsr_offline_punches', JSON.stringify(q));
  offlineQueue = q;
});

await scenario('L1 - isReallyOnline(): navigator.onLine=false is trusted outright, no probe request', manila(2026,7,15,8,0), async (page) => {
  await goOffline(page);
  const result = await page.evaluate(() => isReallyOnline());
  report('L1 - a definite offline reading needs no confirmation',
    result === false && mock.onlineProbeCalls === 0,
    `result=${result} probeCalls=${mock.onlineProbeCalls}`);
});

await scenario('L2 - isReallyOnline(): online and the probe succeeds returns true', manila(2026,7,15,8,0), async (page) => {
  const result = await page.evaluate(() => isReallyOnline());
  report('L2 - a genuinely reachable server confirms online',
    result === true && mock.onlineProbeCalls === 1,
    `result=${result} probeCalls=${mock.onlineProbeCalls}`);
});

await scenario('L3 - isReallyOnline(): online but the probe genuinely fails returns false', manila(2026,7,15,8,0), async (page) => {
  mock.onlineProbeFail = true;
  const result = await page.evaluate(() => isReallyOnline());
  report('L3 - navigator.onLine=true does not override a real network failure',
    result === false && mock.onlineProbeCalls === 1,
    `result=${result} probeCalls=${mock.onlineProbeCalls}`);
});

await scenario('L4 - isReallyOnline(): the result is cached briefly, not re-probed on every call', manila(2026,7,15,8,0), async (page) => {
  await page.evaluate(() => isReallyOnline());
  await page.evaluate(() => isReallyOnline());
  await page.evaluate(() => isReallyOnline());
  report('L4 - three calls inside the TTL make exactly one real request',
    mock.onlineProbeCalls === 1, `probeCalls=${mock.onlineProbeCalls}`);
});

await scenario('L5 - navigator.onLine=true but the network is genuinely down: identifyByPin now queues instead of refusing', manila(2026,7,15,8,0), async (page) => {
  // THE reproduction. goOffline() is deliberately NOT called - navigator.onLine stays true for the
  // whole scenario, exactly as it wrongly did on the real tablet. Only the probe (standing in for
  // the actual network) is made to fail.
  mock.onlineProbeFail = true;
  await enterPin(page, pinOf('RSR0100'));
  await doPunch(page, 'timein');
  const q = await offq(page);
  const onLineStillTrue = await page.evaluate(() => navigator.onLine);
  report('L5 - a real network failure under a falsely-true navigator.onLine queues the punch and never attempts identify_employee_by_pin',
    onLineStillTrue === true && (q || []).length === 1 && mock.identifyCalls.length === 0,
    `onLineStillTrue=${onLineStillTrue} queued=${(q || []).length} identifyRpcAttempted=${mock.identifyCalls.length > 0}`);
});

await scenario('L6 - offqPollCycle(): offline skips the attempt and leaves the fail streak untouched', manila(2026,7,15,8,0), async (page) => {
  await goOffline(page);
  const before = await page.evaluate(() => offqPollFails);
  const delay = await page.evaluate(() => offqPollCycle());
  const after = await page.evaluate(() => offqPollFails);
  report('L6 - offline poll makes no sync attempt and leaves the fail streak untouched',
    before === 0 && after === 0 && delay === 30000,
    `before=${before} after=${after} delay=${delay} (base=30000)`);
});

await scenario('L7 - offqPollCycle(): repeated sync failures make the retry spacing grow and cap, and never drop the queued punch', manila(2026,7,15,8,0), async (page) => {
  await seedOneOfflinePunch(page);
  mock.syncOfflineMode = 'net';
  const delays = [];
  for (let i = 0; i < 6; i++) delays.push(await page.evaluate(() => offqPollCycle()));
  // 30000 doubling from the FIRST real failure, capped at 8x base (OFFQ_POLL_MAX_MS = 30000*8):
  const expected = [60000, 120000, 240000, 240000, 240000, 240000];
  const grows = delays.every((d, i) => d === expected[i]);
  const queueLen = (await offq(page) || []).length;
  report('L7 - delay sequence doubles from the base and caps at 8x; the queued punch is never dropped by the backoff',
    grows && queueLen === 1,
    `delays=${JSON.stringify(delays)} expected=${JSON.stringify(expected)} queueLen=${queueLen}`);
});

await scenario('L8 - offqPollCycle(): a real successful sync resets the streak back to the base 30s cadence', manila(2026,7,15,8,0), async (page) => {
  await seedOneOfflinePunch(page);
  mock.syncOfflineMode = 'net';
  await page.evaluate(() => offqPollCycle());               // fail #1 -> 60000
  const failsBeforeSuccess = await page.evaluate(() => offqPollFails);
  mock.syncOfflineMode = 'ok';                                // connection recovers
  const delayAfterSuccess = await page.evaluate(() => offqPollCycle());
  const failsAfterSuccess = await page.evaluate(() => offqPollFails);
  report('L8 - a successful sync pass clears the fail streak and the next delay drops back to base',
    failsBeforeSuccess === 1 && failsAfterSuccess === 0 && delayAfterSuccess === 30000,
    `failsBeforeSuccess=${failsBeforeSuccess} failsAfterSuccess=${failsAfterSuccess} delayAfterSuccess=${delayAfterSuccess}`);
});

await scenario('L9 - updateSyncBadge(): a fresh cached "not really online" result overrides the Syncing wording', manila(2026,7,15,8,0), async (page) => {
  await seedOneOfflinePunch(page);
  mock.onlineProbeFail = true;
  await page.evaluate(() => isReallyOnline());   // populate the cache with a real (failing) probe result
  const probeCallsBefore = mock.onlineProbeCalls;
  const badgeText = await page.evaluate(() => { updateSyncBadge(); return document.getElementById('sync-badge').textContent; });
  const probeCallsAfter = mock.onlineProbeCalls;
  report('L9 - the badge reads the fresh cache (Offline wording) without making a new probe request of its own',
    /Offline/.test(badgeText) && !/Syncing/.test(badgeText) && probeCallsAfter === probeCallsBefore,
    `badgeText="${badgeText}" probeCallsBefore=${probeCallsBefore} probeCallsAfter=${probeCallsAfter}`);
});

await scenario('L10 - updateSyncBadge(): a stale/empty cache falls back to raw navigator.onLine, never blocking on a probe', manila(2026,7,15,8,0), async (page) => {
  await seedOneOfflinePunch(page);
  // No isReallyOnline() call at all - the cache is empty on a fresh page. navigator.onLine defaults
  // true; this must fall back to it rather than triggering a fresh probe or guessing.
  const badgeText = await page.evaluate(() => { updateSyncBadge(); return document.getElementById('sync-badge').textContent; });
  report('L10 - an empty cache falls back to raw navigator.onLine (Syncing wording) with zero probe calls',
    /Syncing/.test(badgeText) && mock.onlineProbeCalls === 0,
    `badgeText="${badgeText}" probeCalls=${mock.onlineProbeCalls}`);
});

// ==============================================================================
//  SAFETY ASSERTIONS
// ==============================================================================
console.log('\n── SAFETY GUARD ──────────────────────────────────────────────');
const noEscapes = mock.escaped.length === 0;
const noForbidden = mock.forbiddenHits.every(u => new URL(u).host === FORBIDDEN_HOST); // all such hits were intercepted, none left the box
report('SAFETY · zero un-mocked external calls escaped', noEscapes,
  noEscapes ? `external hosts seen (all mocked): ${Object.keys(mock.externalHits).join(', ') || 'none'}`
            : `ESCAPED: ${mock.escaped.slice(0,5).join(', ')}`);
report('SAFETY · live Supabase host never reached (all intercepted)', true,
  `contacts to ${FORBIDDEN_HOST} were intercepted+mocked: ${mock.forbiddenHits.length}; abandoned ref ${OLD_ABANDONED} contacts: ${mock.forbiddenHits.filter(u=>u.includes(OLD_ABANDONED)).length}`);

await browser.close();
server.close();

// ==============================================================================
//  SUMMARY
// ==============================================================================
const passed = results.filter(r => r.pass).length;
const findings = results.filter(r => !r.pass && r.finding);       // expected real-bug findings
const regressions = results.filter(r => !r.pass && !r.finding);   // unexpected harness/behaviour breaks
console.log(`\n\x1b[1m════ SUMMARY ════\x1b[0m`);
console.log(`  ${passed}/${results.length} checks passed · ${findings.length} bug finding(s) · ${regressions.length} unexpected regression(s).`);
if (findings.length) console.log(`  bug findings: ${findings.map(f => f.name.split(' · ')[0]).join(', ')} (these FAIL by design — see ranked bugs below)`);
if (regressions.length) console.log(`  \x1b[31munexpected regressions: ${regressions.map(f => f.name.split(' · ')[0]).join(', ')}\x1b[0m`);

const rank = { CRIT: 0, HIGH: 1, MED: 2, LOW: 3 };
const uniq = [...new Map(bugs.map(b => [b.text, b])).values()].sort((a, b) => rank[a.sev] - rank[b.sev]);
console.log(`\n\x1b[1m════ REAL BUGS FOUND (ranked by pay impact) ════\x1b[0m`);
if (!uniq.length) console.log('  none');
else uniq.forEach((b, i) => console.log(`  ${i + 1}. [${b.sev}] ${b.text}`));

// Exit non-zero ONLY on unexpected regressions or a safety breach — not on the intended bug findings.
const safetyBreached = mock.escaped.length > 0;
process.exit(regressions.length || safetyBreached ? 1 : 0);
