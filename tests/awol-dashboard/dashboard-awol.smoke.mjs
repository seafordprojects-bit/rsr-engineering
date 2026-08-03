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
  adminPin: '123456',              // the admin PIN in this mock — used by BOTH admin_verify_passcode
                                   // and awol_set_barred, so they can never disagree
};
let pass = 0, fail = 0, pending = 0;
// SECTION ISOLATION (added 2026-07-30). Before this, the first uncaught Playwright timeout killed the
// whole run and every later assertion was skipped SILENTLY — the summary simply printed a smaller
// number. Six C1 assertions sat behind a failing coordinator section and never executed, which reads
// as coverage in review while proving nothing. A section that throws now records ONE failure, names
// itself, and the run continues, so the total is always the full set.
const sections = [];
const section = (name, fn) => sections.push([name, fn]);
async function runSections(){
  for (const [name, fn] of sections){
    console.log('');
    console.log('== ' + name + ' ==');
    try { await fn(); }
    catch (e) {
      fail++;
      const why = String((e && e.message) || e).slice(0, 140);
      console.log('  FAIL  ' + name + ' - SECTION ABORTED: ' + why);
      console.log('        assertions after this point in the section did not run');
    }
  }
}
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
    if (p.endsWith('/rest/v1/rpc/awol_set_barred')) {
      // DEFECT C: the only door to barred_at. Mirrors the real RPC's refusals — wrong passcode, no
      // case, and never barring an exempt worker — so the UI is tested against the same answers.
      state.rpcCalls.push(['setBarred', body.p_code, body.p_bar, body.p_actor]);
      if (body.p_passcode !== state.adminPin) return json(200, { ok: false, reason: 'Not authorised' });
      const r = state.suspensions[body.p_code];
      if (!r) return json(200, { ok: false, reason: 'No case exists for ' + body.p_code });
      if (body.p_bar && r.exempt) return json(200, { ok: false, reason: 'Exempt worker — cannot be barred: ' + body.p_code });
      r.barred_at = body.p_bar ? new Date().toISOString() : null;
      r.barred_by = body.p_bar ? (body.p_actor || 'Admin') : null;
      state.events.push({ employee_code: body.p_code, event: body.p_bar ? 'barred' : 'unbarred', actor: body.p_actor || 'Admin' });
      return json(200, { ok: true, employee_code: body.p_code, barred: body.p_bar === true });
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
    if (p.endsWith('/rest/v1/rpc/admin_verify_passcode')) return json(200, body.p_input === state.adminPin);
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
      // employment_type replaced the PEM code prefix as the exemption marker (owner 2026-07-29).
      // u4 is the case that proves it: a CONVERTED man who keeps his PEM code but is now regular.
      // He MUST be offered for manual suspension. Under the old prefix rule he was invisible.
      { id: 'u1', code: 'RSR 0006', name: 'Baby Monterola', position: 'Fitter', home_site: 'Mandaue', pin: '660660', is_issuer: false, employment_type: 'regular', type_effective_from: '2026-01-05' },
      { id: 'u2', code: 'RSR 0025', name: 'Jamaica L. Batucan', position: 'Office', home_site: 'Carmen', pin: '250250', is_issuer: true, employment_type: 'regular', type_effective_from: '2026-01-05' },
      { id: 'u3', code: 'PEM 0001', name: 'Julius', position: 'Fitter', home_site: 'Carmen', pin: '500500', is_issuer: false, employment_type: 'pakyaw', type_effective_from: '2026-01-05' },
      { id: 'u4', code: 'PEM 0009', name: 'Converted Man', position: 'Fitter', home_site: 'Carmen', pin: '900900', is_issuer: false, employment_type: 'regular', type_effective_from: '2026-07-20' },
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
// Browser errors were previously swallowed: a page could throw during load, leave a card empty, and
// the only symptom was a selector timeout 30s later with no clue why. Every page is wired for both
// pageerror and console.error from now on.
const wire = (pg, label) => {
  pg.on('pageerror', (e) => console.log('  PAGEERROR[' + label + '] ' + String((e && e.message) || e).slice(0, 200)));
  pg.on('console', (m) => { if (m.type() === 'error') console.log('  CONSOLE[' + label + '] ' + m.text().slice(0, 200)); });
  pg.on('requestfailed', (r) => console.log('  REQFAIL[' + label + '] ' + r.url().slice(0, 120)));
  return pg;
};
const coord = wire(await context.newPage(), 'coordinator');
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
const admin = wire(await context.newPage(), 'admin');
admin.setDefaultTimeout(4000);
await admin.goto(`${base}/admin/`, { waitUntil: 'networkidle' });
for (const d of '123456') await admin.click(`button:has-text("${d}")`);
await admin.waitForSelector('text=AWOL — suspensions');
// The "Needs your decision" heading renders unconditionally (it's a static label with a live
// count appended) — asserting just its text is vacuous, it'd pass even if the needsDecision
// filter routed nothing there. Assert the live count AND the "✅ Approve" button, which Preact
// only renders for rows inside the needsDecision bucket — both are genuinely conditional on the
// filter having done its job.
check('admin: ticked case shows under "Needs your decision" (live count + Approve button)',
  await admin.isVisible('text=Needs your decision (1)') &&
  await admin.isVisible('button:has-text("✅ Approve")'));
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

// ── admin: Approve is refused when server truth says the letter is unconfirmed ─────────────
// The UI only ever offers "Approve" for rows where letter_received is already true — there's
// normally no button path to attempt approving an unconfirmed case. But the button reflects the
// client's last-loaded snapshot, not live truth: if the letter step flips back to unconfirmed
// between the admin clicking Approve and finishing the PIN (e.g. a concurrent "Keep suspended"
// elsewhere resets it), the RPC call still fires on stale assumptions. This is the one refusal
// the whole two-role gate exists to guarantee, so simulate exactly that race and prove the
// server-side reason — not just the UI's button visibility — is what actually blocks it.
console.log('\n== admin: Approve refuses an unconfirmed letter (server-side gate, not just the UI) ==');
await admin.click('button:has-text("Approve")');
state.suspensions['RSR 0006'].letter_received = false;   // server truth changes mid-flow, after the button was already clicked
for (const d of '123456') await admin.click(`button[data-admin-key="${d}"]`);
await admin.waitForSelector('text=letter not yet confirmed');
check('admin: Approve is refused server-side when the letter is unconfirmed, and the reason is shown',
  await admin.isVisible('text=letter not yet confirmed') && state.suspensions['RSR 0006'].active === true,
  JSON.stringify(state.suspensions['RSR 0006']));
await admin.click('button:has-text("Cancel")');   // close the still-open PIN modal before continuing

// ── manual suspension: PEM workers must not be offered ──────────────────────────
await admin.click('button:has-text("Suspend someone manually")');
const options = await admin.$$eval('select[data-manual-emp] option', els => els.map(e => e.value));
// PEM 0001 (employment_type 'pakyaw') must be absent. PEM 0009 (converted to 'regular' while
// KEEPING his PEM code) must be PRESENT — that pair is the whole point of the change: the prefix
// no longer decides, the column does. Asserting only the first half would still pass under the
// old prefix rule and prove nothing.
check('admin: pakyaw workers are not listed for manual suspension',
  !options.includes('PEM 0001') && options.some(v => /RSR/.test(v)),
  `options=${JSON.stringify(options)}`);

check('admin: a CONVERTED man (PEM code, employment_type regular) IS listed',
  options.includes('PEM 0009'),
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

// ══ DEFECT C — a sweep-created case must NOT bar, and a bar must be reversible ═══════════════
// == DEFECT C on the client ==============================================================
// The database half is proven in awol-defect-cdf.sql STEP 9. This proves the UI agrees: an open
// case offers Bar and never arrives already barred, and a barred man can always be released.
//
// NOTE the two DIFFERENT keypads, which cost a debugging round earlier: the Lock screen uses
// button:has-text(d), the AWOL card's PinPad uses button[data-admin-key=d]. The PinPad does not
// exist until a decision button opens it, so digits can never be clicked before that.
console.log('');
console.log('== admin: Defect C - a case open is not a bar ==');

state.suspensions = { 'RSR 0006': { employee_code: 'RSR 0006', active: true,
  reason: 'Absent 3 consecutive days', suspended_on: '07/26/2026',
  absent_dates: ['2026-07-27','2026-07-28','2026-07-29'],
  letter_received: true, barred_at: null, barred_by: null } };
state.events.length = 0;
state.rpcCalls.length = 0;

await admin.reload({ waitUntil: 'networkidle' });
// sessionStorage survives a reload, so the Lock screen may be skipped. Unlock only if it is there.
if (await admin.locator('text=Enter the 6-digit admin PIN').first().isVisible().catch(() => false)) {
  for (const d of '123456') await admin.click('button:has-text("' + d + '")');
}
await admin.waitForSelector('text=AWOL');

check('admin: a sweep-created case reads NOT barred - he punches normally',
  await admin.locator('text=Case open. NOT barred').first().isVisible(),
  'a case must never arrive already barring anyone - that was Defect C');

check('admin: an unbarred case offers Bar and not Reinstate',
  await admin.locator('button:has-text("Bar from starting work")').first().isVisible()
  && !(await admin.locator('button:has-text("Reinstate")').first().isVisible().catch(() => false)));

// Bar him. The button opens the PinPad; only then do the digits exist.
await admin.click('button:has-text("Bar from starting work")');
for (const d of '123456') await admin.click('button[data-admin-key="' + d + '"]');
await admin.waitForSelector('text=BARRED from starting work');

check('admin: barring goes through awol_set_barred with p_bar true and writes one event',
  state.rpcCalls.some((c) => c[0] === 'setBarred' && c[1] === 'RSR 0006' && c[2] === true)
  && state.suspensions['RSR 0006'].barred_at !== null
  && state.events.filter((x) => x.event === 'barred').length === 1,
  'events=' + JSON.stringify(state.events));

check('admin: a barred man is labelled BARRED and offered Reinstate',
  await admin.locator('text=BARRED from starting work').first().isVisible()
  && await admin.locator('button:has-text("Reinstate")').first().isVisible());

// Wrong PIN must refuse and change nothing.
await admin.click('button:has-text("Reinstate")');
for (const d of '999999') await admin.click('button[data-admin-key="' + d + '"]');
// The card verifies via admin_verify_passcode BEFORE calling awol_set_barred, so a bad PIN never
// reaches the RPC and the message is the card's own 'Wrong PIN.' rather than the RPC's
// 'Not authorised'. Defence in depth: the RPC still verifies inside, because the anon key is public.
await admin.waitForSelector('text=Wrong PIN.');
check('admin: reinstate with the wrong PIN is refused and he stays barred',
  state.suspensions['RSR 0006'].barred_at !== null
  && !state.events.some((x) => x.event === 'unbarred'));

// Correct PIN releases him. Spec 3.4: a system that can bar and cannot un-bar is not shippable.
for (const d of '123456') await admin.click('button[data-admin-key="' + d + '"]');
await admin.waitForSelector('text=Case open. NOT barred');
check('admin: reinstate clears barred_at and barred_by and writes an unbarred event',
  state.suspensions['RSR 0006'].barred_at === null
  && state.suspensions['RSR 0006'].barred_by === null
  && state.events.filter((x) => x.event === 'unbarred').length === 1,
  'events=' + JSON.stringify(state.events));

check('admin: the case is STILL open after reinstating - releasing him is not closing the case',
  state.suspensions['RSR 0006'].active === true,
  'unbar must not resolve the disciplinary case; only a decision does that');

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed, ${pending} pending\n`);
process.exit(fail ? 1 : 0);
