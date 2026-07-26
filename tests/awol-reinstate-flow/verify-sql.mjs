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

// ── 1. cleanup landed ──
const all = await rest('employee_suspensions?select=employee_code,active');
check('walkthrough rows deleted (0 rows remain)', Array.isArray(all.data) && all.data.length === 0,
  `rows=${Array.isArray(all.data) ? all.data.length : JSON.stringify(all.data)}`);
const bak = await rest('bak_employee_suspensions_20260726?select=employee_code');
check('backup table holds the 43 deleted rows', Array.isArray(bak.data) && bak.data.length === 43,
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
const names = (ev.data || []).map(e => e.event);
check('awol_events recorded the whole probe lifecycle',
  ['suspended', 'letter_received', 'kept_suspended', 'reinstated', 'suspended_manual'].every(e => names.includes(e)),
  `events=${names.join(', ')}`);

// ── probe rows: report them, do NOT try to delete ──
// anon holds select/insert/update on employee_suspensions and select/insert on awol_events — by
// design, so a client can never erase an audit trail. The probe rows are removed by the OWNER via
// STEP 14 of the SQL file. This script only reports what is left for them to clear.
const leftover = await rest('employee_suspensions?select=employee_code&or=(employee_code.eq.TEST999,employee_code.eq.PEM%20TEST9)');
console.log(`\nPROBE ROWS TO CLEAR (owner runs STEP 14): ${(leftover.data || []).map(r => r.employee_code).join(', ') || '(none)'}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
