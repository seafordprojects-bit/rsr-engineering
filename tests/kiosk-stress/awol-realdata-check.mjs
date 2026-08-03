// OWNER GATE ITEM (2026-07-26): point AWOL detection at the REAL 2026-07-19 → 2026-07-25
// attendance and prove it now suspends nobody. Those 42 walkthrough rows came from exactly that
// week pre-fix; if anything in it still trips detection it must surface here, not at 6am with 40
// workers blocked at the kiosk.
//
// Reads live attendance READ-ONLY. Every write path (RPC, PATCH, Telegram) is mocked and asserted
// to have received nothing. Run: node tests/kiosk-stress/awol-realdata-check.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOST = 'wpmcbjrisuyjvobvzaus.supabase.co';
const KEY = process.env.RSR_ANON_KEY;
if (!KEY) { console.error('Set RSR_ANON_KEY and re-run.'); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// ── pull the real data (read-only) ────────────────────────────────────────────
// attendance_records.date is TEXT in MIXED formats, so fetch broadly and filter client-side.
const att = await (await fetch(`https://${HOST}/rest/v1/attendance_records?select=*&limit=20000`, { headers: H })).json();
const emps = await (await fetch(`https://${HOST}/rest/v1/employees?select=code,name,pin,home_site,daily_rate,shift`, { headers: H })).json();
let leaves = [];
try { leaves = await (await fetch(`https://${HOST}/rest/v1/leave_requests?select=*&limit=5000`, { headers: H })).json(); } catch (_) { leaves = []; }
console.log(`fetched: ${att.length} attendance rows · ${emps.length} employees · ${(leaves || []).length} leave requests`);

const toISO = (s) => {
  s = String(s || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : s;
};
const inWindow = att.filter(r => { const d = toISO(r.date); return d >= '2026-07-19' && d <= '2026-07-25'; });
console.log(`rows inside 2026-07-19 → 2026-07-25: ${inWindow.length}`);

// ── seed the kiosk's LOCAL attendance cache from the real rows ────────────────
// collectAbsentDates()/isAbsentOnDate() never fetch attendance_records from Supabase — the kiosk
// only ever reads its own localStorage `records` cache (per-device, built from that device's own
// punches). Mocking the /attendance_records GET response is therefore not enough on its own: a
// fresh browser context has an empty cache, so every day would read as "no punch" regardless of
// what really happened. To point detection at the REAL week we replay the real rows into that same
// local cache (localStorage `rsr_records`) before the kiosk's loadData() runs, in the exact shape
// getRec()/collectAbsentDates expect: `${employee_code}_${MM/DD/YYYY}` -> { punches: {...} }.
const toKioskDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); return m ? `${m[2]}/${m[3]}/${m[1]}` : iso; };
const recordsSeed = {};
for (const r of att) {
  if (!r.employee_code) continue;
  const key = `${r.employee_code}_${toKioskDate(toISO(r.date))}`;
  recordsSeed[key] = {
    code: r.employee_code,
    punches: { timein: r.timein || null, lunch_out: r.lunch_out || null, lunch_in: r.lunch_in || null, pm_out: r.pm_out || null, pm_in: r.pm_in || null, timeout: r.timeout || null },
    isLate: !!r.is_late,
  };
}
console.log(`seeded local records cache: ${Object.keys(recordsSeed).length} day-rows`);

// ── serve the repo + run the kiosk with all writes walled off ─────────────────
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const idx = path.join(file, 'index.html');
    if (fs.existsSync(idx)) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(idx)); }
    res.writeHead(404); return res.end('');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}).listen(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const writes = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.addInitScript(() => {
  const FIXED = new Date('2026-07-26T08:00:00+08:00').getTime();
  const R = Date; window.Date = class extends R {
    constructor(...a) { return a.length ? new R(...a) : new R(FIXED); }
    static now() { return FIXED; }
  };
});
await context.addInitScript((seed) => {
  try { localStorage.setItem('rsr_records', JSON.stringify(seed)); } catch (_) {}
}, recordsSeed);
await context.route('**/*', (route) => {
  const url = route.request().url(), method = route.request().method();
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (url.includes(HOST)) {
    if (method !== 'GET') { writes.push(`${method} ${url} ${route.request().postData() || ''}`); return json({}); }
    if (url.includes('/employee_suspensions')) return json([]);         // start from a clean slate
    if (url.includes('/attendance_records')) return json(att);
    if (url.includes('/employees')) return json(emps);
    if (url.includes('/leave_requests')) return json(leaves || []);
    return json([]);
  }
  if (url.includes('api.telegram.org')) { writes.push(`TELEGRAM ${url}`); return json({ ok: true, result: { message_id: 1 } }); }
  if (url.startsWith(base)) return route.continue();
  return json([]);
});

const page = await context.newPage();
await page.goto(`${base}/kiosk/`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => typeof checkAllAbsences === 'function' && Array.isArray(employees) && employees.length > 0);

// DELIBERATELY does NOT call checkAllAbsences(). On 2026-07-26 an unscoped checkAllAbsences() run
// against the live roster suspended 42 real workers and fired ~20 group alerts. collectAbsentDates()
// is a PURE READ over `records` — it computes the identical absence chain that checkAllAbsences would
// act on, with no code path that can write, alert, or suspend. The route interception below is the
// second layer; not calling the mutating function at all is the first.
//
// (Task 9, 2026-07-26 follow-up) The FIRST run of this gate (Task 8) reported 10 workers would be
// suspended, computed from `!pem && chain.length>=3` alone. Investigation found 8 of those 10 have
// ZERO attendance rows EVER (not just in-window) — 4 Mandaue workers with no working kiosk yet, 2
// workers who no longer work here, and RSR 0000/0023 (office roles that never clock in). Production
// detection (checkAllAbsences(), kiosk/index.html) was fixed to skip any worker with no real Time In
// in the last 30 days (hasRecentPunchHistory()) and any worker flagged is_active===false, BEFORE ever
// suspending. This gate must mirror that same skip logic or it is testing the OLD, already-fixed
// behavior instead of what production actually does today — so the filter below now matches
// checkAllAbsences()'s real gates exactly (both are pure reads, so this stays a read-only check).
// is_active is NOT in the /employees select above (that column doesn't exist in the live DB until
// the owner runs awol-inactive-workers.sql) — e.isActive defaults true until then, which is correct:
// today, the never-punched/30-day net is the only one of the two gates this live run can exercise.
const perWorker = await page.evaluate(() => employees.map(e => ({
  code: e.code, name: e.name, pem: isPemCode(e.code),
  inactive: e.isActive === false,
  hasHistory: hasRecentPunchHistory(e.code),
  chain: collectAbsentDates(e.code),
})));

const wouldSuspend = perWorker.filter(w => !w.pem && !w.inactive && w.hasHistory && w.chain.length >= 3);
console.log(`\nPEM workers skipped: ${perWorker.filter(w => w.pem).map(w => w.code).join(', ') || '(none)'}`);
console.log(`inactive workers skipped: ${perWorker.filter(w => w.inactive).map(w => w.code).join(', ') || '(none)'}`);
console.log(`never-punched/30-day-safety-net skips: ${perWorker.filter(w => !w.pem && !w.inactive && !w.hasHistory).map(w => w.code).join(', ') || '(none)'}`);
if (wouldSuspend.length) {
  console.log(`\n\x1b[31mWORKERS THAT WOULD BE SUSPENDED:\x1b[0m`);
  wouldSuspend.forEach(w => console.log(`  ${w.code} ${w.name} — ${w.chain.length} absences: ${w.chain.join(', ')}`));
}

const ok = wouldSuspend.length === 0 && writes.length === 0;
console.log(`\n${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  real-data detection over 2026-07-19 → 2026-07-25`);
console.log(`      wouldSuspend=${wouldSuspend.length} writesAttempted=${writes.length} (must both be 0)`);
if (writes.length) writes.forEach(w => console.log(`      \x1b[33mWRITE ATTEMPT: ${w}\x1b[0m`));

await browser.close(); server.close();
process.exit(ok ? 0 : 1);
