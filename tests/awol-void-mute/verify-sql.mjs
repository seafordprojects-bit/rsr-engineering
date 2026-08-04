// Verifies awol-void-mute.sql AFTER the owner has run it in the Supabase SQL editor.
//
// SCOPE — read this before trusting a green run.
// This script exercises everything the ANON key can reach: the new columns, the two RPCs, their
// refusals, and the guarantee that nothing outside the PIN-gated door can write the mute columns.
// It CANNOT prove the mute itself, because voiding requires the admin PIN and this script must
// never hold one. The mute semantics are proved by the `do $$ ... $$` assertion block in STEP 6 of
// awol-void-mute.sql, which runs as the table owner and raises if any assertion fails.
// BOTH must pass before anything ships. A green run here alone means "the door is fitted", not
// "the lock works".
//
// Run: node tests/awol-void-mute/verify-sql.mjs
const URL_BASE = 'https://wpmcbjrisuyjvobvzaus.supabase.co';
const KEY = process.env.RSR_ANON_KEY;
if (!KEY) { console.error('Set RSR_ANON_KEY (the anon key from supabase.js) and re-run.'); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const PROBE = 'ZZ VOIDTEST';   // matches the 'ZZ BARTEST' convention: no real code can collide

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

// ── 0. migration probe — is awol-void-mute.sql applied yet? ──
// voided_at is created in STEP 1 and did not exist before it. awol_set_suspended ALREADY exists in
// production from an earlier build, so running the mutating section below against a pre-migration
// database would write a real probe row into live data and prove nothing. Detect that state up
// front, exactly as tests/awol-reinstate-flow/verify-sql.mjs does.
const colProbe = await rest('employee_suspensions?select=voided_at&limit=1');
const migrationApplied = colProbe.status === 200;
if (!migrationApplied) {
  console.log('\x1b[33mNOTICE\x1b[0m: migration not yet applied — employee_suspensions.voided_at was not found.');
  console.log('Running surface checks only. No RPC that writes will be called.\n');
}

// ── 1. the four mute columns exist ──
const cols = await rest('employee_suspensions?select=employee_code,voided_at,voided_by,voided_reason,voided_note&limit=1');
check('all 4 mute columns selectable', cols.status === 200, `status=${cols.status} ${JSON.stringify(cols.data)}`);

// ── 2. both RPCs exist and REFUSE a wrong PIN ──
// A missing function answers 404 with PGRST202; a present one answers 200 with {ok:false}. The
// distinction is the point — "refused" and "not there" must never look the same to this script.
const voidBadPin = await rpc('awol_void_case', {
  p_code: PROBE, p_passcode: '000000', p_reason_kind: 'counted_wrong', p_actor: 'probe', p_note: 'probe',
});
check('awol_void_case exists', voidBadPin.status !== 404,
  `status=${voidBadPin.status} ${JSON.stringify(voidBadPin.data)}`);
check('awol_void_case REFUSES a wrong PIN',
  voidBadPin.status === 200 && voidBadPin.data && voidBadPin.data.ok === false && /not authorised/i.test(voidBadPin.data.reason || ''),
  JSON.stringify(voidBadPin.data));

const relBadPin = await rpc('awol_release_mute', { p_code: PROBE, p_passcode: '000000', p_actor: 'probe' });
check('awol_release_mute exists', relBadPin.status !== 404,
  `status=${relBadPin.status} ${JSON.stringify(relBadPin.data)}`);
check('awol_release_mute REFUSES a wrong PIN',
  relBadPin.status === 200 && relBadPin.data && relBadPin.data.ok === false && /not authorised/i.test(relBadPin.data.reason || ''),
  JSON.stringify(relBadPin.data));

// ── 3. the reason kind is validated, and only the two agreed values are accepted ──
// Checked BEFORE the PIN inside the function: it is input shape, not authorisation, and it leaks
// nothing that is not already in this repo. Being before the PIN is also what makes it testable
// from here without ever holding a real passcode.
const badKind = await rpc('awol_void_case', {
  p_code: PROBE, p_passcode: '000000', p_reason_kind: 'because_i_said_so', p_actor: 'probe', p_note: null,
});
check('awol_void_case rejects an unknown void reason',
  badKind.data && badKind.data.ok === false && /reason/i.test(badKind.data.reason || ''),
  JSON.stringify(badKind.data));

// ── 4. anon cannot write the mute columns directly ──
// The whole design rests on this. If REST can set voided_at, the PIN gate is decoration: anyone
// holding the public anon key could silence detection for any worker without leaving an audit row.
const direct = await rest(`employee_suspensions?employee_code=eq.${encodeURIComponent(PROBE)}`, {
  method: 'PATCH', body: JSON.stringify({ voided_at: new Date().toISOString() }),
});
check('anon CANNOT set voided_at through REST',
  direct.status >= 400,
  `HTTP ${direct.status} ${JSON.stringify(direct.data)} — a 2xx means the column grant did not narrow; STOP`);

const directBy = await rest(`employee_suspensions?employee_code=eq.${encodeURIComponent(PROBE)}`, {
  method: 'PATCH', body: JSON.stringify({ voided_by: 'forged' }),
});
check('anon CANNOT set voided_by through REST', directBy.status >= 400,
  `HTTP ${directBy.status} ${JSON.stringify(directBy.data)}`);

if (!migrationApplied) {
  console.log(`\n${pass} passed, ${fail} failed\n`);
  console.log('Behaviour checks were SKIPPED and wrote nothing. Re-run after the owner applies awol-void-mute.sql,');
  console.log('and confirm STEP 6 of that file raised no exception — that block, not this script, proves the mute.');
  process.exit(fail ? 1 : 0);
}

try {
  // ── 6. REGRESSION: an ordinary, un-muted case still opens exactly once ──
  // The mute must not change the normal path. This is the behaviour every night depends on.
  const s1 = await rpc('awol_set_suspended', { p_code: PROBE, p_reason: 'probe — 3 consecutive days', p_dates: ['2026-07-20'], p_on: '08/04/2026' });
  check('un-muted: awol_set_suspended opens the case (newly=true)', s1.data === true, JSON.stringify(s1.data));
  const s2 = await rpc('awol_set_suspended', { p_code: PROBE, p_reason: 'probe — repeat sweep', p_dates: ['2026-07-20'], p_on: '08/04/2026' });
  check('un-muted: a second sweep does NOT re-open (newly=false)', s2.data === false, JSON.stringify(s2.data));

  const row = await rest(`employee_suspensions?select=active,voided_at,voided_by,voided_reason&employee_code=eq.${encodeURIComponent(PROBE)}`);
  check('a freshly opened case is NOT muted (voided_at is null)',
    row.data && row.data[0] && row.data[0].active === true && row.data[0].voided_at === null,
    JSON.stringify(row.data));

  // ── 7. the one legitimate anon write still works ──
  const stamp = await rest(`employee_suspensions?employee_code=eq.${encodeURIComponent(PROBE)}`, {
    method: 'PATCH', body: JSON.stringify({ awol_group_msg_id: '999', awol_group_chat: '-100probe' }),
  });
  check('anon CAN still stamp awol_group_msg_id (kiosk alert path unbroken)',
    stamp.status >= 200 && stamp.status < 300, `HTTP ${stamp.status} ${JSON.stringify(stamp.data)}`);

  // ── 8. voiding is the ONLY way a row becomes muted, and it needs the PIN ──
  const stillOpen = await rest(`employee_suspensions?select=active,voided_at&employee_code=eq.${encodeURIComponent(PROBE)}`);
  check('after every anon attempt above, the probe is STILL un-muted and open',
    stillOpen.data && stillOpen.data[0] && stillOpen.data[0].active === true && stillOpen.data[0].voided_at === null,
    JSON.stringify(stillOpen.data));

  // ── 9. audit vocabulary — 'voided' and 'mute_released' are distinct events ──
  // Not asserting they were WRITTEN (that needs the PIN); asserting the log is readable and that
  // no probe row forged one. The events themselves are proved in STEP 6 of the SQL.
  const ev = await rest(`awol_events?select=event,actor&employee_code=eq.${encodeURIComponent(PROBE)}&order=at.asc`);
  const names = Array.isArray(ev.data) ? ev.data.map(e => e.event) : [];
  check('probe audit trail contains only the detection event, no forged void',
    Array.isArray(ev.data) && !names.includes('voided') && !names.includes('mute_released'),
    `events=${names.join(', ') || '(none)'}`);

  // ── probe rows: report, do NOT delete ──
  // anon holds no DELETE on either table, by design. STEP 7 of awol-void-mute.sql clears these.
  const leftover = await rest(`employee_suspensions?select=employee_code&employee_code=eq.${encodeURIComponent(PROBE)}`);
  console.log(`\nPROBE ROWS TO CLEAR (owner runs STEP 7): ${(Array.isArray(leftover.data) ? leftover.data : []).map(r => r.employee_code).join(', ') || '(none)'}`);
} catch (err) {
  check('behaviour checks completed without throwing', false, `threw: ${err && err.stack || err}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
console.log('REMINDER: this script cannot prove the mute. STEP 6 of awol-void-mute.sql does that.');
process.exit(fail ? 1 : 0);
