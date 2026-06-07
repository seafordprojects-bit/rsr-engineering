// ============================================================
//  home.js — RSR Engineering admin dashboard (the start page)
//  PIN-gated. Shows live summaries; links into each module.
// ============================================================
import { html, render } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import { supabase } from './supabase.js';

const SESSION_KEY = 'rsr_admin';          // shared unlock flag for this browser session
const PIN_KEY = 'rsr_admin_pin';          // changeable PIN (default 1234)

// count helper — returns a number, or null if the table/column isn't ready
async function countRows(table, build) {
  try {
    let q = supabase.from(table).select('*', { count: 'exact', head: true });
    if (build) q = build(q);
    const { count, error } = await q;
    if (error) throw error;
    return count || 0;
  } catch (_) { return null; }
}
async function getEmployees() {
  const { data, error } = await supabase.from('employees')
    .select('id, name, code, position, phone, started_on, pin, sl_balance, vl_balance, daily_rate').order('name').limit(2000);
  if (error) throw error;
  return data;
}
async function getSalaryHistory(empId) {
  const { data, error } = await supabase.from('salary_history')
    .select('id, daily_rate, effective_date, note').eq('employee_id', empId)
    .order('effective_date', { ascending: false }).limit(100);
  if (error) throw error;
  return data;
}
async function addSalaryChange(empId, rate, date, note) {
  const { error } = await supabase.from('salary_history')
    .insert({ employee_id: empId, daily_rate: rate, effective_date: date || null, note: note || null });
  if (error) throw error;
  await supabase.from('employees').update({ daily_rate: rate }).eq('id', empId);  // current rate
}
async function getBorrowedNow() {
  const { data, error } = await supabase.from('borrow_issuance')
    .select('id, quantity, borrowed_at, project_vessel, items(name, item_code, unit), employees(name), item_units(unit_code), sites(name)')
    .eq('status', 'out').order('borrowed_at', { ascending: false }).limit(500);
  if (error) throw error;
  return data;
}
async function getRepairUnits() {
  const { data, error } = await supabase.from('item_units')
    .select('id, unit_code, defect, repair_eta, items(name, item_code), sites(name)')
    .eq('status', 'repair').eq('active', true).order('unit_code').limit(500);
  if (error) throw error;
  return data;
}
async function getInventory() {
  const { data: units, error: e1 } = await supabase.from('item_units')
    .select('item_id, site_id, status, items(name), sites(name)').eq('active', true).limit(5000);
  if (e1) throw e1;
  const { data: outs, error: e2 } = await supabase.from('borrow_issuance')
    .select('item_id, site_id').eq('status', 'out').limit(5000);
  if (e2) throw e2;
  return { units, outs };
}
// attendance dates are stored in PH format (MM/DD/YYYY) by the kiosk
function todayPH() { return new Date().toLocaleDateString('en-PH', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
function todayYmd() { const d = new Date(), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }
function ymdToPH(ymd) { if (!ymd) return todayPH(); const [y, m, d] = ymd.split('-'); return `${m}/${d}/${y}`; }
async function getAttendance(dateStr) {
  const { data, error } = await supabase.from('attendance_records').select('*').eq('date', dateStr).order('employee_name');
  if (error) throw error;
  return data || [];
}
async function updateEmployee(id, fields) {
  const { error } = await supabase.from('employees').update(fields).eq('id', id);
  if (error) throw error;
}
async function getSetting(key) {
  const { data } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  return data ? data.value : null;
}
async function setSetting(key, value) {
  const { data } = await supabase.from('settings').select('id').eq('key', key).maybeSingle();
  if (data) { const { error } = await supabase.from('settings').update({ value }).eq('key', key); if (error) throw error; }
  else { const { error } = await supabase.from('settings').insert({ key, value }); if (error) throw error; }
}

function Field({ label, children }) {
  return html`<div class="field"><label>${label}</label>${children}</div>`;
}

function Lock({ onUnlock, onBack, toast }) {
  const [pin, setPin] = useState('');
  const tryUnlock = () => {
    const admin = localStorage.getItem(PIN_KEY) || '1234';
    if (pin === admin) { sessionStorage.setItem(SESSION_KEY, '1'); onUnlock(); }
    else toast('Wrong PIN');
  };
  return html`
    <div class="wrap">
      <div class="card lock">
        <div class="brand" style="justify-content:center;margin-bottom:6px"><b>RSR</b><span class="tag">ADMIN</span></div>
        <p class="note" style="margin:0 0 14px">Admin login</p>
        <${Field} label="Enter admin PIN">
          <input type="password" inputmode="numeric" value=${pin}
            onInput=${e => setPin(e.target.value)} placeholder="default 1234"
            onKeyDown=${e => { if (e.key === 'Enter') tryUnlock(); }} />
        <//>
        <button class="btn" onClick=${tryUnlock}>Unlock</button>
        ${onBack && html`<button class="btn ghost" style="margin-top:8px" onClick=${onBack}>← Back</button>`}
      </div>
    </div>`;
}

function Tile({ ico, num, unit, title, href, onClick }) {
  const inner = html`
    <div class="ico">${ico}</div>
    <div class=${'num' + (num == null ? ' dim' : '')}>${num == null ? '—' : num}</div>
    <h3>${title}</h3>
    <div class="unit">${unit}</div>`;
  if (onClick) return html`<div class="tile" style="cursor:pointer" onClick=${onClick}>${inner}</div>`;
  return href
    ? html`<a class="tile" href=${href}>${inner}</a>`
    : html`<div class="tile soon">${ico ? html`<div class="ico">${ico}</div>` : ''}<h3 style="margin-top:8px">${title}</h3><span class="badge">COMING SOON</span></div>`;
}

function App() {
  const [view, setView] = useState('choose');   // 'choose' | 'admin'
  const [adminTab, setAdminTab] = useState('dash');  // 'dash' | 'people'
  const [authed, setAuthed] = useState(sessionStorage.getItem(SESSION_KEY) === '1');
  const [m, setM] = useState({});
  const [showSet, setShowSet] = useState(false);
  const [curPin, setCurPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [emps, setEmps] = useState([]);
  const [empSel, setEmpSel] = useState('');
  const [empPin, setEmpPin] = useState('');
  const [empSick, setEmpSick] = useState('');
  const [empVac, setEmpVac] = useState('');
  const [coordPin, setCoordPin] = useState('');
  const [rate, setRate] = useState('');          // current/starting daily rate
  const [incRate, setIncRate] = useState('');     // new rate for an increase
  const [incDate, setIncDate] = useState('');
  const [incNote, setIncNote] = useState('');
  const [salHist, setSalHist] = useState([]);
  const [bor, setBor] = useState(null);     // borrowed-now list
  const [rep, setRep] = useState(null);     // repair units
  const [inv, setInv] = useState(null);     // { units, outs }
  const [att, setAtt] = useState(null);     // today's attendance summary
  const [attRows, setAttRows] = useState(null);  // per-employee rows for the monitor
  const [attYmd, setAttYmd] = useState(todayYmd());
  const [toast, setToast] = useState(null);
  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2400); };

  const changePin = () => {
    const admin = localStorage.getItem(PIN_KEY) || '1234';
    if (curPin !== admin) { flash('Current PIN is wrong'); return; }
    if (!newPin.trim()) { flash('Enter a new PIN'); return; }
    localStorage.setItem(PIN_KEY, newPin.trim());
    setCurPin(''); setNewPin(''); flash('Admin PIN changed');
  };

  const saveCoordPin = async () => {
    if (!coordPin.trim()) { flash('Enter a passcode'); return; }
    try { await setSetting('coordinator_pin', coordPin.trim()); setCoordPin(''); flash('Assistant passcode set'); }
    catch (e) { flash('Error: ' + e.message); }
  };

  const loadEmps = async () => { try { setEmps(await getEmployees()); } catch (_) {} };
  const pickEmp = async (id) => {
    setEmpSel(id);
    const e = emps.find(x => x.id === id) || {};
    setEmpPin(e.pin || ''); setEmpSick(e.sl_balance ?? ''); setEmpVac(e.vl_balance ?? '');
    setRate(e.daily_rate ?? ''); setIncRate(''); setIncDate(''); setIncNote('');
    try { setSalHist(await getSalaryHistory(id)); } catch (_) { setSalHist([]); }
  };
  const saveRate = async () => {
    if (!empSel) { flash('Pick an employee'); return; }
    try { await updateEmployee(empSel, { daily_rate: rate === '' ? null : Number(rate) }); flash('Daily rate saved'); loadEmps(); }
    catch (e) { flash('Error: ' + e.message); }
  };
  const addIncrease = async () => {
    if (!empSel) { flash('Pick an employee'); return; }
    if (incRate === '') { flash('Enter the new rate'); return; }
    try {
      await addSalaryChange(empSel, Number(incRate), incDate, incNote);
      setRate(incRate); setIncRate(''); setIncDate(''); setIncNote('');
      setSalHist(await getSalaryHistory(empSel)); loadEmps();
      flash('Salary increase recorded');
    } catch (e) { flash('Error: ' + e.message); }
  };
  const saveEmp = async () => {
    if (!empSel) { flash('Pick an employee'); return; }
    try {
      await updateEmployee(empSel, {
        pin: empPin.trim() || null,
        sl_balance: empSick === '' ? 0 : Number(empSick),
        vl_balance: empVac === '' ? 0 : Number(empVac),
      });
      flash('Saved'); loadEmps();
    } catch (e) { flash('Error: ' + e.message); }
  };

  useEffect(() => {
    if (!authed || view !== 'admin') return;
    const iso30 = new Date(Date.now() - 30 * 864e5).toISOString();
    (async () => {
      const [toolsOut, inRepair, issued30, vessels, people] = await Promise.all([
        countRows('borrow_issuance', q => q.eq('txn_type', 'borrow').eq('status', 'out')),
        countRows('item_units', q => q.eq('active', true).eq('status', 'repair')),
        countRows('borrow_issuance', q => q.eq('txn_type', 'issuance').gte('borrowed_at', iso30)),
        countRows('voyages', q => q.neq('status', 'not_active')),
        countRows('employees', q => q),
      ]);
      setM({ toolsOut, inRepair, issued30, vessels, people });
      try {
        const recs = await getAttendance(todayPH());
        const c = (f) => recs.filter(f).length;
        const present = c(r => r.status !== 'absent');
        setAtt({ working: c(r => r.status === 'working'), onBreak: c(r => r.status === 'break'),
                 out: c(r => r.status === 'out'), late: c(r => r.is_late),
                 total: people || 0, absent: Math.max(0, (people || 0) - present) });
      } catch (_) { setAtt(null); }
    })();
  }, [authed, view]);

  useEffect(() => {
    if (!(authed && view === 'admin' && adminTab === 'attendance')) return;
    (async () => { try { setAttRows(await getAttendance(ymdToPH(attYmd))); } catch (e) { flash('Load failed: ' + e.message); } })();
  }, [adminTab, attYmd, authed, view]);

  useEffect(() => { if (authed && view === 'admin') loadEmps(); }, [authed, view]);
  useEffect(() => { if (authed && showSet) loadEmps(); }, [authed, showSet]);

  useEffect(() => {
    if (!(authed && view === 'admin')) return;
    if (adminTab === 'borrowed') (async () => {
      try { setBor(await getBorrowedNow()); setInv(await getInventory()); }
      catch (e) { flash('Load failed: ' + e.message); }
    })();
    if (adminTab === 'repair') (async () => {
      try { setRep(await getRepairUnits()); }
      catch (e) { flash('Load failed: ' + e.message); }
    })();
  }, [adminTab, authed, view]);

  // auto-logout the admin after 2 minutes of no activity
  useEffect(() => {
    if (!(authed && view === 'admin')) return;
    let t;
    const logout = () => { sessionStorage.removeItem(SESSION_KEY); setAuthed(false); setView('choose'); setShowSet(false); setAdminTab('dash'); };
    const reset = () => { clearTimeout(t); t = setTimeout(logout, 2 * 60 * 1000); };
    const evs = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
    evs.forEach(e => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => { clearTimeout(t); evs.forEach(e => window.removeEventListener(e, reset)); };
  }, [authed, view]);

  // ---- front chooser: Admin | Coordinator ----
  if (view === 'choose') return html`
    <header class="app">
      <div class="wrap"><div class="brand"><b>RSR</b><span class="tag">ENGINEERING</span></div></div>
    </header>
    <div class="wrap">
      <div class="sectlabel">Choose your area</div>
      <div class="grid">
        <div class="tile" style="cursor:pointer" onClick=${() => setView('admin')}>
          <div class="ico">🛠️</div>
          <h3>Admin</h3>
          <div class="unit">Dashboard, passcodes, salary, leave</div>
        </div>
        <a class="tile" href="./coordinator/">
          <div class="ico">🗂️</div>
          <h3>Coordinator</h3>
          <div class="unit">Personnel &amp; vessel schedules</div>
        </a>
      </div>
      <p class="note" style="text-align:center;margin-top:6px">RSR Engineering Services · Cebu</p>
    </div>
    ${toast && html`<div class="toast">${toast}</div>`}`;

  // ---- admin login ----
  if (!authed) return html`<${Lock} onUnlock=${() => setAuthed(true)} onBack=${() => setView('choose')} toast=${flash} />
    ${toast && html`<div class="toast">${toast}</div>`}`;

  const live = [
    { ico:'🔧', num:m.toolsOut,  unit:'out now',        title:'Tool Borrowing',   onClick:() => setAdminTab('borrowed') },
    { ico:'📦', num:m.issued30,  unit:'issued (30 days)', title:'Material Issuance', href:'./borrower-equipments/' },
    { ico:'🛠️', num:m.inRepair,  unit:'in repair',       title:'Tool Repair',      onClick:() => setAdminTab('repair') },
    { ico:'🚢', num:m.vessels,   unit:'active',          title:'Vessel Schedule',  href:'./coordinator/' },
    { ico:'👷', num:m.people,    unit:'on file',         title:'Personnel',        onClick:() => setAdminTab('people') },
    { ico:'⏱️', num:att ? att.working : null, unit:'working now', title:'Time In / Out', onClick:() => setAdminTab('attendance') },
  ];
  const soon = [
    { ico:'📝', title:'Leave Approval' },
    { ico:'📊', title:'Project Status' },
    { ico:'💰', title:'Cash Advance / Payroll' },
  ];

  // ---- admin: tool borrowing monitor (out now + inventory per site) ----
  if (adminTab === 'borrowed') {
    const dt = (s) => s ? new Date(s).toLocaleDateString() : '—';
    // aggregate inventory: site -> item -> { owned, repair, out }
    const sm = {};
    if (inv) {
      (inv.units || []).forEach(u => {
        const sid = u.site_id || 'none', sname = (u.sites && u.sites.name) || 'Unassigned';
        const iid = u.item_id, iname = (u.items && u.items.name) || '—';
        sm[sid] = sm[sid] || { name: sname, items: {} };
        const it = sm[sid].items[iid] = sm[sid].items[iid] || { name: iname, owned: 0, repair: 0, out: 0 };
        it.owned++; if (u.status === 'repair') it.repair++;
      });
      (inv.outs || []).forEach(o => {
        const sid = o.site_id || 'none', iid = o.item_id;
        if (sm[sid] && sm[sid].items[iid]) sm[sid].items[iid].out++;
      });
    }
    const sites = Object.values(sm).sort((a, b) => a.name.localeCompare(b.name));
    return html`
      <header class="app"><div class="wrap"><div class="brand" style="justify-content:space-between;display:flex;align-items:center">
        <span><b>RSR</b><span class="tag">TOOL BORROWING</span></span>
        <button onClick=${() => setAdminTab('dash')} style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">← Dashboard</button>
      </div></div></header>
      <div class="wrap">
        <div class="card">
          <label>Currently borrowed${bor ? ` (${bor.length})` : ''}</label>
          ${bor == null ? html`<div class="empty">Loading…</div>`
            : bor.length ? bor.map(b => html`
              <div class="row" key=${b.id} style="align-items:flex-start">
                <div>
                  <div class="name">${b.items ? b.items.name : '—'} ${b.item_units && b.item_units.unit_code ? html`<span class="mono" style="color:var(--ink-dim);font-weight:400">· ${b.item_units.unit_code}</span>` : ''}</div>
                  <div class="unit">${b.employees ? b.employees.name : '—'}${b.project_vessel ? ' · ' + b.project_vessel : ''}</div>
                  <div class="unit">${(b.sites && b.sites.name) || '—'} · ${dt(b.borrowed_at)}${b.quantity > 1 ? ' · qty ' + b.quantity : ''}</div>
                </div>
                <span class="badge" style="background:var(--hivis);color:#000">OUT</span>
              </div>`)
            : html`<div class="empty">Nothing borrowed right now.</div>`}
        </div>

        <div class="sectlabel">Inventory by site</div>
        ${inv == null ? html`<div class="card"><div class="empty">Loading…</div></div>`
          : sites.length ? sites.map(s => html`
            <div class="card" key=${s.name}>
              <label>${s.name}</label>
              ${Object.values(s.items).sort((a, b) => a.name.localeCompare(b.name)).map(it => {
                const avail = it.owned - it.repair - it.out;
                return html`<div class="row">
                  <div><div class="name">${it.name}</div>
                    <div class="unit">${it.out ? it.out + ' out · ' : ''}${it.repair ? it.repair + ' repair · ' : ''}owned ${it.owned}</div></div>
                  <div class=${'num' + (avail <= 0 ? ' dim' : '')} style="font-size:20px">${avail}</div>
                </div>`;
              })}
            </div>`)
          : html`<div class="card"><div class="empty">No tools registered yet.</div></div>`}
        <p class="note" style="text-align:center">View only. The big number is available now.</p>
      </div>
      ${toast && html`<div class="toast">${toast}</div>`}`;
  }

  // ---- admin: tool repair monitor ----
  if (adminTab === 'repair') {
    return html`
      <header class="app"><div class="wrap"><div class="brand" style="justify-content:space-between;display:flex;align-items:center">
        <span><b>RSR</b><span class="tag">TOOL REPAIR</span></span>
        <button onClick=${() => setAdminTab('dash')} style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">← Dashboard</button>
      </div></div></header>
      <div class="wrap">
        <div class="card">
          <label>In repair${rep ? ` (${rep.length})` : ''}</label>
          ${rep == null ? html`<div class="empty">Loading…</div>`
            : rep.length ? rep.map(u => html`
              <div class="row" key=${u.id} style="align-items:flex-start">
                <div>
                  <div class="name">${u.items ? u.items.name : '—'} <span class="mono" style="color:var(--ink-dim);font-weight:400">· ${u.unit_code}</span></div>
                  <div class="unit">Location: ${(u.sites && u.sites.name) || 'Unassigned'}</div>
                  ${u.defect ? html`<div class="unit">Defect: ${u.defect}</div>` : ''}
                  ${u.repair_eta ? html`<div class="unit">ETA: ${u.repair_eta}</div>` : ''}
                </div>
                <span class="badge">REPAIR</span>
              </div>`)
            : html`<div class="empty">No tools in repair.</div>`}
        </div>
        <p class="note" style="text-align:center">View only.</p>
      </div>
      ${toast && html`<div class="toast">${toast}</div>`}`;
  }

  // ---- admin: attendance monitor (per-employee, by date) ----
  if (adminTab === 'attendance') {
    const pill = { working:'#12B89E', break:'var(--hivis)', out:'#888', incomplete:'#E8A830', absent:'#D64045', late:'#D64045' };
    const lbl = { working:'Working', break:'Break', out:'Out', incomplete:'Incomplete', absent:'Absent', late:'Late' };
    return html`
      <header class="app"><div class="wrap"><div class="brand" style="justify-content:space-between;display:flex;align-items:center">
        <span><b>RSR</b><span class="tag">ATTENDANCE</span></span>
        <button onClick=${() => setAdminTab('dash')} style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">← Dashboard</button>
      </div></div></header>
      <div class="wrap">
        <div class="card">
          <${Field} label="Date">
            <input type="date" value=${attYmd} onInput=${e => { setAttRows(null); setAttYmd(e.target.value); }} />
          <//>
          <label>${ymdToPH(attYmd) === todayPH() ? 'Today' : 'Records'}${attRows ? ` (${attRows.length})` : ''}</label>
          ${attRows == null ? html`<div class="empty">Loading…</div>`
            : attRows.length ? attRows.map(r => html`
              <div class="row" key=${r.id || r.employee_name} style="align-items:flex-start">
                <div>
                  <div class="name">${r.employee_name}${r.is_late ? html` <span class="badge" style="background:#D64045;color:#fff">LATE</span>` : ''}</div>
                  <div class="unit">In ${r.timein || '—'} · Out ${r.timeout || '—'}${r.worked_ms ? ' · ' + (r.worked_ms / 3600000).toFixed(1) + 'h' : ''}</div>
                </div>
                <span class="badge" style=${'background:' + (pill[r.status] || '#888') + ';color:#fff'}>${lbl[r.status] || r.status || '—'}</span>
              </div>`)
            : html`<div class="empty">No attendance records for this date.</div>`}
        </div>
        <p class="note" style="text-align:center">View only. Punches come from the attendance kiosk.</p>
      </div>
      ${toast && html`<div class="toast">${toast}</div>`}`;
  }

  // ---- admin: personnel roster (read-only list with details) ----
  if (adminTab === 'people') {
    const peso = (n) => n ? '₱' + Number(n).toLocaleString('en-PH') : '—';
    return html`
      <header class="app">
        <div class="wrap"><div class="brand" style="justify-content:space-between;display:flex;align-items:center">
          <span><b>RSR</b><span class="tag">PERSONNEL</span></span>
          <button onClick=${() => setAdminTab('dash')}
            style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">← Dashboard</button>
        </div></div>
      </header>
      <div class="wrap">
        <div class="card">
          <label>Personnel (${emps.length})</label>
          ${emps.length ? [...emps].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(e => html`
            <div class="row" key=${e.id} style="align-items:flex-start">
              <div>
                <div class="name">${e.name} <span class="mono" style="color:var(--ink-dim);font-weight:400">· ${e.code || '—'}</span></div>
                <div class="unit">${e.position || 'No position'}${e.phone ? ' · ' + e.phone : ''}</div>
                <div class="unit">Rate: ${peso(e.daily_rate)}/day · Sick: ${e.sl_balance ?? 0} · Vacation: ${e.vl_balance ?? 0}</div>
              </div>
              <span class="badge" style=${e.pin ? '' : 'background:var(--hivis);color:#000'}>${e.pin ? 'PIN ✓' : 'no PIN'}</span>
            </div>`) : html`<div class="empty">No personnel yet. Your assistant adds them in the Coordinator.</div>`}
        </div>
        <p class="note" style="text-align:center">View only. To set passcode, leave or salary, use the dashboard's <b>settings</b>.</p>
      </div>
      ${toast && html`<div class="toast">${toast}</div>`}`;
  }

  return html`
    <header class="app">
      <div class="wrap"><div class="brand" style="justify-content:space-between;display:flex;align-items:center">
        <span><b>RSR</b><span class="tag">ENGINEERING</span></span>
        <span style="display:flex;gap:12px;align-items:center">
          <button onClick=${() => setShowSet(s => !s)}
            style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">settings</button>
          <button onClick=${() => { sessionStorage.removeItem(SESSION_KEY); setAuthed(false); setView('choose'); setShowSet(false); setAdminTab('dash'); }}
            style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">home</button>
        </span>
      </div></div>
    </header>
    <div class="wrap">
      ${(() => {
        const needs = emps.filter(e => !e.pin).length;
        return needs > 0 ? html`
          <div class="card" style="border-color:var(--hivis);cursor:pointer" onClick=${() => setShowSet(true)}>
            <div style="font-weight:800;color:var(--hivis)">⚠ ${needs} employee${needs>1?'s':''} need a passcode</div>
            <p class="note" style="margin:4px 0 0">Newly added by the assistant. Tap to assign their kiosk PIN.</p>
          </div>` : '';
      })()}

      ${showSet && html`
        <div class="card">
          <div class="sectlabel" style="margin-top:0">Change admin PIN</div>
          <${Field} label="Current PIN"><input type="password" inputmode="numeric" value=${curPin} onInput=${e => setCurPin(e.target.value)} /><//>
          <${Field} label="New PIN"><input type="password" inputmode="numeric" value=${newPin} onInput=${e => setNewPin(e.target.value)} /><//>
          <button class="btn" onClick=${changePin}>Save new PIN</button>
          <p class="note" style="margin-top:10px">This is the single admin password (dashboard + coordinator). Stored on this device.</p>
        </div>

        <div class="card">
          <div class="sectlabel" style="margin-top:0">Assistant (coordinator) passcode</div>
          <p class="note" style="margin:0 0 12px">The passcode your assistant uses to open the coordinator page on her own device.</p>
          <${Field} label="Set / change assistant passcode">
            <input type="password" inputmode="numeric" value=${coordPin} onInput=${e => setCoordPin(e.target.value)} placeholder="e.g. 4321" />
          <//>
          <button class="btn" onClick=${saveCoordPin}>Save assistant passcode</button>
        </div>

        <div class="card">
          <div class="sectlabel" style="margin-top:0">Employee passcode &amp; leave</div>
          <p class="note" style="margin:0 0 12px">Set the worker's sign-in PIN and their leave balances. The assistant can see these but can't change them.</p>
          <${Field} label="Employee">
            <select value=${empSel} onChange=${e => pickEmp(e.target.value)}>
              <option value="">Select employee…</option>
              ${[...emps].sort((a, b) => (!!a.pin - !!b.pin) || (a.name || '').localeCompare(b.name || ''))
                .map(e => html`<option value=${e.id}>${e.pin ? '✓' : '⚠'} ${e.name} (${e.code || '—'})</option>`)}
            </select>
          <//>
          ${empSel && (() => {
            const e = emps.find(x => x.id === empSel) || {};
            return html`<div class="card" style="background:var(--panel-2);margin:0 0 14px">
              <div class="name">${e.name} <span class="mono" style="color:var(--ink-dim);font-weight:400">· ${e.code || '—'}</span></div>
              <div class="unit">${e.position || '—'}${e.phone ? ' · ' + e.phone : ''}${e.started_on ? ' · since ' + e.started_on : ''}</div>
              <div class="unit">Leave — Sick ${e.sl_balance ?? 0} · Vacation ${e.vl_balance ?? 0}</div>
              <div class="unit">Daily rate — ${e.daily_rate ? '₱' + Number(e.daily_rate).toLocaleString('en-PH') : 'not set'}</div>
              <div class="unit">Passcode — ${e.pin ? 'set ✓' : 'not set ⚠'}</div>
            </div>`;
          })()}
          ${empSel && html`
            <${Field} label="Passcode (PIN)">
              <input inputmode="numeric" value=${empPin} onInput=${e => setEmpPin(e.target.value)} placeholder="e.g. 1234" />
            <//>
            <div class="grid" style="margin-bottom:14px">
              <${Field} label="Sick leave (days)"><input type="number" min="0" step="0.5" value=${empSick} onInput=${e => setEmpSick(e.target.value)} placeholder="0" /><//>
              <${Field} label="Vacation leave (days)"><input type="number" min="0" step="0.5" value=${empVac} onInput=${e => setEmpVac(e.target.value)} placeholder="0" /><//>
            </div>
            <button class="btn" onClick=${saveEmp}>Save</button>`}
        </div>

        ${empSel && html`
        <div class="card">
          <div class="sectlabel" style="margin-top:0">Salary — ${(emps.find(x=>x.id===empSel)||{}).name || ''}</div>
          <${Field} label="Daily rate (current / starting) ₱">
            <input type="number" min="0" value=${rate} onInput=${e => setRate(e.target.value)} placeholder="0" />
          <//>
          <button class="btn ghost" onClick=${saveRate}>Save daily rate</button>

          <div style="border-top:1px solid var(--line);margin:16px 0 12px"></div>
          <div class="sectlabel" style="margin-top:0">Record a salary increase</div>
          <div class="grid" style="margin-bottom:0">
            <${Field} label="New daily rate ₱"><input type="number" min="0" value=${incRate} onInput=${e => setIncRate(e.target.value)} placeholder="0" /><//>
            <${Field} label="Effective date"><input type="date" value=${incDate} onInput=${e => setIncDate(e.target.value)} /><//>
          </div>
          <${Field} label="Note (optional)"><input value=${incNote} onInput=${e => setIncNote(e.target.value)} placeholder="e.g. annual increase" /><//>
          <button class="btn" onClick=${addIncrease}>Add increase</button>

          ${salHist.length > 0 && html`
            <div style="margin-top:14px">
              <div class="sectlabel">Salary history</div>
              ${salHist.map(h => html`
                <div class="row" key=${h.id}>
                  <div>
                    <div class="name">₱${Number(h.daily_rate).toLocaleString('en-PH')}/day</div>
                    <div class="unit">${h.effective_date || '—'}${h.note ? ' · ' + h.note : ''}</div>
                  </div>
                </div>`)}
            </div>`}
        </div>`}`}

      ${att && html`
        <div class="sectlabel">Attendance today</div>
        <div class="card" style="cursor:pointer" onClick=${() => setAdminTab('attendance')}>
          <div style="display:flex;gap:14px;overflow-x:auto;text-align:center">
            ${[['Working', att.working], ['On break', att.onBreak], ['Timed out', att.out], ['Late', att.late], ['Absent', att.absent], ['Total', att.total]]
              .map(([k, v]) => html`<div style="min-width:54px">
                <div style="font-size:22px;font-weight:800;color:var(--ink)">${v}</div>
                <div class="unit">${k}</div>
              </div>`)}
          </div>
        </div>`}

      <div class="sectlabel">Live overview</div>
      <div class="grid">
        ${live.map(t => html`<${Tile} ...${t} />`)}
      </div>

      <div class="sectlabel">On the roadmap</div>
      <div class="grid">
        ${soon.map(t => html`<${Tile} ...${t} />`)}
      </div>

      <p class="note" style="text-align:center;margin-top:6px">RSR Engineering Services · Cebu</p>
    </div>
    ${toast && html`<div class="toast">${toast}</div>`}
  `;
}

render(html`<${App} />`, document.getElementById('app'));
