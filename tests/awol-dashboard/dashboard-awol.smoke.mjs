// Playwright smoke over the coordinator + admin dashboard AWOL surfaces with Supabase fully mocked.
// Nothing here touches the live project — the real host is walled off.
// Run: node tests/awol-dashboard/dashboard-awol.smoke.mjs
//
// NOTE on running this: this repo has no package.json/node_modules of its own (no build step,
// per CLAUDE.md) — the app itself never needs one. Playwright + its chromium download already
// exist locally under tests/kiosk-stress/node_modules (installed for the kiosk stress harness).
// Node's ESM resolver only walks *ancestor* node_modules from the importing file, and
// tests/kiosk-stress is a sibling of tests/awol-dashboard, not an ancestor — so a bare
// `import 'playwright'` here cannot see it (NODE_PATH is a CommonJS-only mechanism and does not
// affect ESM resolution). Try the normal bare import first (works once/if this folder or a repo
// root ever gets its own node_modules); fall back to a relative import of the already-installed
// package next door.
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  ({ chromium } = await import(new URL('../kiosk-stress/node_modules/playwright/index.mjs', import.meta.url)));
}
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const FORBIDDEN_HOST = 'wpmcbjrisuyjvobvzaus.supabase.co'; // the live project — must never be hit
// .mjs matters: coordinator.js imports ./monitoring/vessel.mjs, and browsers refuse a <script
// type=module> import served as application/octet-stream (the map's fallback) with a hard error.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const state = {
  suspensions: {},
  events: [],
  rpcCalls: [],
  tgCalls: [],                     // { chatId, text } — every mocked Telegram sendMessage
  clerkPin: '250250',              // Jamaica's PIN in this mock
};
let pass = 0, fail = 0, pending = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${name}${detail ? `\n        ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
// Kept for future not-yet-built sections of this test (e.g. Task 6's manual re-suspension form) —
// unused now that the admin dashboard AWOL card (Task 5) is built and its checks run for real below.
const pend = (name, why) => {
  console.log(`  \x1b[33mPEND\x1b[0m  ${name}\n        ${why}`);
  pending++;
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
    if (p.endsWith('/rest/v1/settings')) {
      const all = [
        { key: 'coordinator_pin', value: '1234' },
        { key: 'tg_token', value: 'TESTTOKEN0000000000000000000000000000' },
        { key: 'tg_awol_group', value: '-1001112223334' },
        { key: 'mgr_ids', value: '111,222' },
      ];
      // getSetting() does .eq('key', k).maybeSingle() — filter by the real query string and
      // unwrap to a single object (or null), matching what PostgREST actually returns for
      // maybeSingle. Returning the full array regardless of the filter (as a naive mock would)
      // silently breaks every getSetting() call: coordinator.js would treat `data.value` on an
      // array as undefined and every "if (!token) return" guard would fire, so Telegram alerts
      // would look wired up in code review but never actually fire — caught by re-adding a
      // Telegram-delivery assertion below and watching it fail against the naive version.
      const m = u.search.match(/key=eq\.([^&]+)/);
      if (m) { const want = decodeURIComponent(m[1]); return json(200, all.find(r => r.key === want) || null); }
      return json(200, all);
    }
    // employees/voyages/sites etc. loaded by App() on boot but not exercised here — empty is fine
    return json(200, []);
  }

  if (url.includes('api.telegram.org')) {
    let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
    state.tgCalls.push({ chatId: body.chat_id, text: body.text });
    return json(200, { ok: true, result: { message_id: 4242 } });
  }

  // Everything else (esm.sh module fetches, Google Fonts, the local static server, data: URIs, …)
  // is real content unrelated to the pay-critical Supabase project — let it hit the real network.
  // A catch-all json(200, []) here would silently break the `preact`/`htm`/`@supabase-js` imports
  // (the pages import them via an esm.sh importmap) and nothing would ever render.
  return route.continue();
});

// ── coordinator page: only Jamaica's PIN may tick ───────────────────────────────
state.suspensions['RSR 0006'] = { employee_code: 'RSR 0006', active: true, reason: 'Absent 3 consecutive days',
  suspended_on: '07/26/2026', absent_dates: ['2026-07-22','2026-07-23','2026-07-24'],
  letter_received: false, awol_group_msg_id: '9001', awol_group_chat: '-1001112223334' };

console.log('\n== coordinator: AWOL letters card ==');
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
check('coordinator: a Telegram alert went to the AWOL group chat (not a raw manager DM)',
  state.tgCalls.some(c => c.chatId === '-1001112223334' && /Letter received/.test(c.text || '')),
  `tgCalls=${JSON.stringify(state.tgCalls)}`);

// ── admin dashboard: gate + decisions — Task 5 ──────────────────────────────────
console.log('\n== admin: AWOL suspensions dashboard ==');
const admin = await context.newPage();
admin.setDefaultTimeout(4000);
await admin.goto(`${base}/admin/`, { waitUntil: 'networkidle' });
for (const d of '123456') await admin.click(`button:has-text("${d}")`);
await admin.waitForSelector('text=AWOL — suspensions');
check('admin: ticked case shows under "Needs your decision"',
  await admin.isVisible('text=Needs your decision'));
await admin.click('button:has-text("Keep suspended")');
for (const d of '123456') await admin.click(`button[data-admin-key="${d}"]`);
// NOTE: the sectlabel "Waiting for the letter (N)" is always on screen (it's a static heading with
// a live count, not a state-dependent card) — waiting for that text resolves immediately and races
// ahead of the RPC round trip. Wait for the toast this decision actually produces instead, so the
// PIN-signed awol_admin_decide('keep') call is guaranteed to have completed before asserting on it.
await admin.waitForSelector('text=Baby Monterola stays suspended');   // proves awol_admin_decide('keep') resolved
check('admin: keep-suspended clears the tick and the worker stays blocked',
  state.suspensions['RSR 0006'].active === true && state.suspensions['RSR 0006'].letter_received === false);
await admin.waitForSelector('text=Nothing waiting on you.');   // proves the post-decision reload re-rendered
check('admin: no Approve button while the case is waiting for the letter',
  !(await admin.isVisible('button:has-text("Approve")')));

// ── manual re-suspension (wrong-approval recovery) ──────────────────────────────
state.suspensions['RSR 0006'].letter_received = true;
state.events.push({ id: 1, employee_code: 'RSR 0006', event: 'reinstated', actor: 'Admin', at: '2026-07-26T02:00:00Z' });
await admin.reload({ waitUntil: 'networkidle' });
for (const d of '123456') await admin.click(`button:has-text("${d}")`);
await admin.click('button:has-text("Approve")');
for (const d of '123456') await admin.click(`button[data-admin-key="${d}"]`);
await admin.waitForSelector('text=Baby Monterola can punch again');   // proves awol_admin_decide('approve') resolved
check('admin: approve closes the case', state.suspensions['RSR 0006'].active === false);

await admin.click('button:has-text("Re-suspend (letter on file)")');
for (const d of '123456') await admin.click(`button[data-admin-key="${d}"]`);
await admin.waitForSelector('text=Baby Monterola is suspended');   // proves awol_manual_suspend resolved
check('admin: re-suspension carries the letter forward and lands at "needs decision"',
  state.suspensions['RSR 0006'].active === true &&
  state.suspensions['RSR 0006'].letter_received === true &&
  /letter already on file/i.test(state.suspensions['RSR 0006'].ref_note || ''),
  JSON.stringify(state.suspensions['RSR 0006']));

// ── manual suspension: PEM workers must not be offered ──────────────────────────
await admin.click('button:has-text("Suspend someone manually")');
const options = await admin.$$eval('select[data-manual-emp] option', els => els.map(e => e.value));
check('admin: PEM workers are not listed for manual suspension',
  !options.some(v => /^PEM/i.test(String(v).replace(/\s/g, ''))) && options.some(v => /RSR/.test(v)),
  `options=${JSON.stringify(options)}`);

// ── manual suspension: at least one date is required ─────────────────────────────
await admin.selectOption('select[data-manual-emp]', 'RSR 0025');
await admin.fill('input[data-manual-reason]', 'no-show, no contact');
await admin.fill('input[data-manual-dates]', '');
await admin.click('button:has-text("Create suspension")');
for (const d of '123456') await admin.click(`button[data-admin-key="${d}"]`);
await admin.waitForSelector('text=at least one absent date');
check('admin: manual suspension refused with no dates',
  (!state.suspensions['RSR 0025'] || state.suspensions['RSR 0025'].active !== true) &&
  !state.rpcCalls.some(c => c[0] === 'manual' && c[1] === 'RSR 0025'));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed, ${pending} pending\n`);
process.exit(fail ? 1 : 0);
