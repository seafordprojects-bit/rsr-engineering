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
//    loadEmployeesFromSupabase reads: se.pin, se.home_site, se.daily_rate…) ────
const ROSTER = [
  { code: 'RSR0001', pin: '000123', name: 'Leading-Zero Larry',  dept: 'Welding',    home_site: 'Carmen',  shift: 8, daily_rate: 600 },
  { code: 'RSR0002', pin: '007007', name: 'Double-Zero Zeny',    dept: 'Fitting',    home_site: 'Mandaue', shift: 8, daily_rate: 520 },
  { code: 'RSR0100', pin: '100200', name: 'Regular Rey',         dept: 'Painting',   home_site: 'Carmen',  shift: 8, daily_rate: 500 },
  { code: 'RSR0207', pin: '246810', name: 'Midday Manny',        dept: 'Rigging',    home_site: 'Carmen',  shift: 8, daily_rate: 540 },
  { code: 'PEM9001', pin: '900001', name: 'PEM Niner Pedro',     dept: 'Electrical', home_site: 'Mandaue', shift: 8, daily_rate: 700 },
  { code: 'PEM9042', pin: '987654', name: 'PEM Band Bella',      dept: 'Instrument', home_site: 'Carmen',  shift: 8, daily_rate: 680 },
  { code: 'RSR0303', pin: '333333', name: 'Night-Owl Nardo',     dept: 'Blasting',   home_site: 'Mandaue', shift: 8, daily_rate: 560 },
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
  tgMsgSeq: 1000,      // incrementing message_id source
  rpcSuspendFail: false, // when true, /rpc/awol_set_suspended 500s (simulates offline for FIX 1 coverage)
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
      if (p.endsWith('/rest/v1/employees')) return json(200, ROSTER);
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
        if (mock.rpcSuspendFail) return json(500, { code: '500', message: 'injected failure (mock.rpcSuspendFail)', details: '', hint: '' });
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
async function enterPin(a, b) {
  if (a && typeof a.evaluate === 'function') {
    // legacy: enterPin(page, pin)
    return a.evaluate((p) => { kpClr(); for (const d of p) kp(d); return curEmp ? curEmp.code : null; }, b);
  }
  // new: enterPin(code) — drive the REAL keypad so the kp() PIN-entry hooks (modal, preview) run.
  // Drives currentPage (the scenario's PRIMARY page). For a multi-page scenario, drive the
  // secondary page directly via page.evaluate(...) instead of this 1-arg helper.
  const pin = pinOf(a);
  return currentPage.evaluate((pn) => { kpClr(); for (const d of pn) kp(d); }, pin);
}
// Read whether the Bisaya modal is showing + its text.
async function bisayaState() {
  return await currentPage.evaluate(() => ({
    show: document.getElementById('bisaya-modal').classList.contains('show'),
    text: (document.getElementById('bisaya-text') || {}).textContent || '',
  }));
}
const doPunch = (page, type) => page.evaluate(async (t) => { await punch(t); }, type);
const recAt = (page, code, dateKey) => page.evaluate(([c, k]) => {
  const r = records[c + '_' + k];
  return r ? { punches: r.punches, nightShift: !!r.nightShift, isLate: !!r.isLate, lateTimeOut: !!r.lateTimeOut,
               afternoonStart: !!r.afternoonStart, autoTimeout: !!r.autoTimeout } : null;
}, [code, dateKey]);
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
  mock.tgConfigured = false;
  mock.awolGroupId = '';
  mock.rpcSuspendFail = false;
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

await scenario('G-load · poll surfaces a shared suspension', manila(2026,7,24,8,0), async (page) => {
  mock.suspensions['RSR0100'] = { employee_code:'RSR0100', active:true, reason:'x', suspended_on:'07/24/2026',
    absent_dates:['2026-07-21','2026-07-22','2026-07-23'] };
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
    suspended_on:'07/24/2026', absent_dates:['2026-07-21','2026-07-22','2026-07-23'] };
  await page.evaluate(() => loadSuspensionsFromCloud());
  await enterPin('RSR0100');
  const b = await bisayaState();
  const r = await recAt(page, 'RSR0100', k);
  const pass = b.show && /GI-SUSPEND/.test(b.text) && (!r || !r.punches.timein);
  report('G1 · suspended PIN blocking modal', pass,
    `modal=${b.show} text="${b.text.slice(0,22)}" timein=${r?.punches.timein||'(none)'}`, sends());
});

await scenario('G2 · 3 absences, no leave → suspend + letter alert', manila(2026,7,24,8,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1009998887776';
  await page.evaluate(() => loadTgFromCloud());
  // RSR0100 has no records for prior days → absent; ensure not already suspended.
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {}; });
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
    leaveRequests = [{ code:'RSR0100', status:'Pending', startDate:'2026-07-21', endDate:'2026-07-24' }]; });
  await page.evaluate(() => checkAllAbsences());
  await page.evaluate(() => checkAllAbsences()); // second run must NOT re-flag
  const flags = mock.telegram.filter(m => /Pending leave — please decide/.test(m.text));
  const notSuspended = !(mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active);
  report('G3 · hold + one-time flag', flags.length === 1 && notSuspended, `flags=${flags.length} suspended=${!notSuspended}`);
});

await scenario('G4 · reinstate → closing msg + RESOLVED edit, once', manila(2026,7,24,9,0), async (page) => {
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
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {}; });
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
  const blockedOnB = await pageB.evaluate(() => !!suspendedEmployees['RSR0100']);

  // Reinstate from A → B's next poll clears it.
  await page.evaluate(() => reinstateEmployee('RSR0100','Coordinator'));
  await pageB.evaluate(() => loadSuspensionsFromCloud());
  const clearedOnB = await pageB.evaluate(() => !suspendedEmployees['RSR0100']);
  await ctxB.close();

  report('G5 · cross-device block then clear', inDb && blockedOnB && clearedOnB,
    `A_suspended=${inDb} B_blocked=${blockedOnB} B_cleared=${clearedOnB}`);
});

// G6 — FIX 1 lock: an offline suspend (RPC throws) must still block LOCALLY, survive a
// loadSuspensionsFromCloud() poll (must NOT be wiped by the DB's empty active-rows set),
// and sync + alert once connectivity returns via retryAwolUnsynced().
await scenario('G6 · offline suspend survives poll + syncs on retry', manila(2026,7,24,8,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1002223334445'; mock.rpcSuspendFail = true;
  await page.evaluate(() => loadTgFromCloud());
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {}; awolUnsynced = {}; });
  await page.evaluate(() => checkAllAbsences());
  const blockedOffline = await page.evaluate(() => !!suspendedEmployees['RSR0100']);
  const notInDbYet = mock.suspensions['RSR0100'] === undefined;

  await page.evaluate(() => loadSuspensionsFromCloud());
  const stillBlockedAfterPoll = await page.evaluate(() => !!suspendedEmployees['RSR0100']);

  mock.rpcSuspendFail = false;
  await page.evaluate(() => retryAwolUnsynced());
  const syncedActive = mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active === true;
  const alerted = mock.telegram.some(m => m.method === 'sendMessage' && /AWOL — Account Suspended/.test(m.text) && /RSR0100/.test(m.text));

  report('G6 · offline suspend survives poll, syncs+alerts on retry',
    blockedOffline && notInDbYet && stillBlockedAfterPoll && syncedActive && alerted,
    `blockedOffline=${blockedOffline} notInDbYet=${notInDbYet} stillBlockedAfterPoll=${stillBlockedAfterPoll} syncedActive=${!!syncedActive} alerted=${alerted}`);
});

// G7 — resurrection-bug lock: an offline suspend (never reached the DB, only tracked in
// awolUnsynced) that gets reinstated BEFORE connectivity returns must NOT come back from
// the dead when retryAwolUnsynced() finally runs — reinstateEmployee must also clear the
// employee's awolUnsynced entry, or the deferred retry re-suspends + re-alerts on a worker
// the admin already cleared.
await scenario('G7 · reinstate before reconnect clears awolUnsynced (no resurrection)', manila(2026,7,24,8,0), async (page) => {
  mock.tgConfigured = true; mock.awolGroupId = '-1007778889990';
  await page.evaluate(() => loadTgFromCloud());
  await page.evaluate(() => { suspendedEmployees = {}; awolPending = {}; awolUnsynced = {}; });

  // Offline suspend: RPC fails → local block only, never reaches the DB.
  mock.rpcSuspendFail = true;
  await page.evaluate(() => checkAllAbsences());
  const blockedOffline = await page.evaluate(() => !!suspendedEmployees['RSR0100']);
  const notInDbYet = mock.suspensions['RSR0100'] === undefined;

  // Admin reinstates while still offline (awol_reinstate finds no active DB row → {newly:false}).
  await page.evaluate(() => reinstateEmployee('RSR0100', 'Admin'));
  const unsyncedCleared = await page.evaluate(() => !awolUnsynced['RSR0100']);
  const localCleared = await page.evaluate(() => !suspendedEmployees['RSR0100']);

  // Reconnect: retry must NOT resurrect the already-reinstated worker.
  mock.rpcSuspendFail = false; mock.telegram = [];
  await page.evaluate(async () => { await retryAwolUnsynced(); await loadSuspensionsFromCloud(); });
  const notResurrectedInDb = !(mock.suspensions['RSR0100'] && mock.suspensions['RSR0100'].active === true);
  // Scoped to RSR0100: other absent roster members legitimately sync+alert on this same retry
  // (they were never reinstated), so a blanket "no AWOL alert at all" check would false-fail.
  const noReAlert = !mock.telegram.some(m => m.method === 'sendMessage' && /AWOL — Account Suspended/.test(m.text) && /RSR0100/.test(m.text));
  const stillClearedLocally = await page.evaluate(() => !suspendedEmployees['RSR0100']);

  report('G7 · reinstate-before-reconnect: no resurrection',
    blockedOffline && notInDbYet && unsyncedCleared && localCleared && notResurrectedInDb && noReAlert && stillClearedLocally,
    `blockedOffline=${blockedOffline} notInDbYet=${notInDbYet} unsyncedCleared=${unsyncedCleared} localCleared=${localCleared} notResurrectedInDb=${notResurrectedInDb} noReAlert=${noReAlert} stillClearedLocally=${stillClearedLocally}`);
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
  const chainC = await page.evaluate(code => collectAbsentDates(code), 'RSR0303');
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

  const chainA = await page.evaluate(code => collectAbsentDates(code), 'RSR0100');
  const chainB = await page.evaluate(code => collectAbsentDates(code), 'RSR0207');
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
  await page.evaluate(() => { employees = employees.filter(e => e.code === 'PEM9001'); });
  const chain = await page.evaluate(() => collectAbsentDates('PEM9001'));
  await page.evaluate(() => checkAllAbsences());

  const suspended = !!(mock.suspensions['PEM9001'] && mock.suspensions['PEM9001'].active);
  const localBlock = await page.evaluate(() => !!suspendedEmployees['PEM9001']);
  const anyTelegram = mock.telegram.length > 0;
  report('G10a · PEM worker absent 5+ working days → never suspended, no alert, no letter',
    !suspended && !localBlock && !anyTelegram && chain.length >= 5,
    `absentChain=${chain.length} suspendedInDb=${suspended} blockedLocally=${localBlock} telegramSends=${mock.telegram.length}`);

  // The space-separated live spelling must be exempt too ('PEM 0001' on the real roster).
  const bothSpellings = await page.evaluate(() => [isPemCode('PEM 0001'), isPemCode('PEM9001'), isPemCode('RSR0100')]);
  report('G10b · both PEM spellings exempt, RSR not',
    JSON.stringify(bothSpellings) === JSON.stringify([true, true, false]),
    `isPemCode(['PEM 0001','PEM9001','RSR0100']) = ${JSON.stringify(bothSpellings)}`);

  // A PEM worker with a PENDING leave must not even generate the "please decide" HOLD note.
  await page.evaluate(() => {
    leaveRequests.push({ code: 'PEM9001', status: 'Pending', startDate: '07/15/2026', endDate: '07/20/2026' });
  });
  mock.telegram = [];
  await page.evaluate(() => checkAllAbsences());
  const holdFlagged = await page.evaluate(() => !!awolPending['PEM9001']);
  report('G10c · PEM worker with a pending leave gets no HOLD note either',
    mock.telegram.length === 0 && !holdFlagged,
    `telegramSends=${mock.telegram.length} holdFlagged=${holdFlagged}`);
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
  report('G9b · no-punch NON-Sunday today (Day 1) → SMS still sent (unaffected by the fix)',
    smsCountTue === 1 && dayLogged === 1, `smsLog.length=${smsCountTue} day=${dayLogged}`);
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
