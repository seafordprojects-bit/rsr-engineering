// ============================================================
//  coordinator.js — RSR Coordinator panel
//  PIN-gated admin page for encoding personnel + vessel schedules.
//  Reuses the same Supabase project as the tool app.
// ============================================================
import { html, render } from 'htm/preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import { supabase, getSites } from './supabase.js';

// ---------- data ----------
async function getEmployees() {
  const { data, error } = await supabase.from('employees')
    .select('id, code, name, dept, position, phone, network, home_site, pin, started_on, sl_balance, vl_balance, is_suspended')
    .order('name').limit(2000);
  if (error) throw error;
  return data;
}
async function addEmployee(row) {
  const { error } = await supabase.from('employees').insert(row);
  if (error) throw error;
}
async function updateEmployee(id, fields) {
  const { error } = await supabase.from('employees').update(fields).eq('id', id);
  if (error) throw error;
}
async function getSetting(key) {
  const { data } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  return data ? data.value : null;
}
async function getVoyages() {
  const { data, error } = await supabase.from('voyages')
    .select('*, sites(name)').order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  return data;
}
async function addVoyage(row) {
  const { error } = await supabase.from('voyages').insert(row);
  if (error) throw error;
}
async function updateVoyage(id, fields) {
  const { error } = await supabase.from('voyages').update(fields).eq('id', id);
  if (error) throw error;
}
async function deleteVoyage(id) {
  const { error } = await supabase.from('voyages').delete().eq('id', id);
  if (error) throw error;
}
async function getExpenses() {
  const { data, error } = await supabase.from('expenses').select('*').order('created_at', { ascending: false }).limit(1000);
  if (error) throw error;
  return data || [];
}
async function addExpense(row) {
  const { error } = await supabase.from('expenses').insert(row);
  if (error) throw error;
}
async function deleteExpense(id) {
  const { error } = await supabase.from('expenses').delete().eq('id', id);
  if (error) throw error;
}
function todayPH() { return new Date().toLocaleDateString('en-PH', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
async function fileLeave(row) {
  const { error } = await supabase.from('leave_requests').insert(row);
  if (error) throw error;
}
async function getRecentLeaves() {
  const { data, error } = await supabase.from('leave_requests')
    .select('*').eq('filed_by', 'Coordinator').order('created_at', { ascending: false }).limit(10);
  if (error) throw error;
  return data || [];
}
async function fileDuty(row) {
  const { error } = await supabase.from('straight_duty').insert(row);
  if (error) throw error;
}
async function getRecentDuties() {
  const { data, error } = await supabase.from('straight_duty')
    .select('*').order('created_at', { ascending: false }).limit(20);
  if (error) throw error;
  return data || [];
}
// notify managers on Telegram (same flow the kiosk uses); silently no-ops if unconfigured
async function notifyTg(text, buttons) {
  try {
    const token = await getSetting('tg_token');
    const mgr = await getSetting('mgr_ids');
    if (!token || !mgr) return;
    const ids = mgr.split(',').map(s => s.trim()).filter(Boolean);
    const reply_markup = buttons ? { inline_keyboard: [buttons] } : undefined;
    await Promise.all(ids.map(id => fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: id, text, parse_mode: 'HTML', reply_markup }),
    }).catch(() => {})));
  } catch (_) {}
}

// ---------- small ui ----------
function Field({ label, children }) {
  return html`<div class="field"><label>${label}</label>${children}</div>`;
}

// ---------- PIN gate (coordinator's own passcode, set by admin, stored in DB) ----------
function Lock({ onUnlock, toast }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const tryUnlock = async () => {
    setBusy(true);
    let saved = '1234';                       // default until the admin sets one
    try { const v = await getSetting('coordinator_pin'); if (v) saved = v; } catch (_) {}
    setBusy(false);
    if (pin === saved) { sessionStorage.setItem('rsr_coord', '1'); onUnlock(); }
    else toast('Wrong passcode', true);
  };
  return html`
    <div class="card lock">
      <div class="brand" style="justify-content:center;margin-bottom:14px"><b>RSR</b><span class="tag">COORDINATOR</span></div>
      <${Field} label="Enter coordinator passcode">
        <input type="password" inputmode="numeric" value=${pin}
          onInput=${e => setPin(e.target.value)} placeholder="passcode"
          onKeyDown=${e => { if (e.key === 'Enter') tryUnlock(); }} />
      <//>
      <button class="btn" disabled=${busy} onClick=${tryUnlock}>${busy ? 'Checking…' : 'Unlock'}</button>
    </div>`;
}

// ---------- Personnel ----------
function Personnel({ employees, onReload, toast }) {
  const [code, setCode] = useState('');           // holds existing code when editing
  const [editKey, setEditKey] = useState(null);   // holds the row uuid when editing
  const [empType, setEmpType] = useState('RSR');   // RSR = regular, PEM = pakyaw
  const [name, setName] = useState('');
  const [position, setPosition] = useState('');
  const [phone, setPhone] = useState('');
  const [started, setStarted] = useState('');
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);

  // next code in a series, e.g. "RSR 0001" → "RSR 0002"
  const nextCode = (prefix) => {
    let max = 0;
    (employees || []).forEach(e => {
      const c = e.code || '';
      if (c.startsWith(prefix + ' ')) {
        const n = parseInt(c.slice(prefix.length + 1), 10);
        if (!isNaN(n) && n > max) max = n;
      }
    });
    return prefix + ' ' + String(max + 1).padStart(4, '0');
  };
  const autoCode = nextCode(empType);              // shown while adding
  const shownCode = editId ? code : autoCode;

  const reset = () => { setCode(''); setEditKey(null); setEmpType('RSR'); setName(''); setPosition(''); setPhone(''); setStarted(''); setEditId(null); };

  const submit = async () => {
    if (!name.trim()) { toast('Enter a name', true); return; }
    setSaving(true);
    try {
      if (editId) {
        await updateEmployee(editKey, { name: name.trim(), position: position.trim() || null, phone: phone.trim() || null, started_on: started || null });
        toast('Employee updated');
      } else {
        await addEmployee({ id: crypto.randomUUID(), code: autoCode, name: name.trim(), position: position.trim() || null, phone: phone.trim() || null, started_on: started || null, sl_balance: 0, vl_balance: 0 });
        toast('Employee added · ' + autoCode);
      }
      reset(); onReload();
    } catch (e) { toast('Error: ' + e.message, true); }
    finally { setSaving(false); }
  };

  const edit = (e) => { setEditId(e.code || e.id); setEditKey(e.id); setCode(e.code || ''); setName(e.name || ''); setPosition(e.position || ''); setPhone(e.phone || ''); setStarted(e.started_on || ''); };

  return html`
    <div class="card">
      <${Field} label="Full name">
        <input value=${name} onInput=${e => setName(e.target.value)} placeholder="e.g. Juan Dela Cruz" />
      <//>
      ${!editId && html`
        <${Field} label="Employee type">
          <select value=${empType} onChange=${e => setEmpType(e.target.value)}>
            <option value="RSR">Regular (RSR)</option>
            <option value="PEM">Pakyaw (PEM)</option>
          </select>
        <//>`}
      <${Field} label="Employee code (auto)">
        <input value=${shownCode} disabled placeholder="auto-generated" />
      <//>
      <${Field} label="Position">
        <input value=${position} onInput=${e => setPosition(e.target.value)} placeholder="e.g. Fitter" />
      <//>
      <${Field} label="Contact number">
        <input type="tel" inputmode="tel" value=${phone} onInput=${e => setPhone(e.target.value)} placeholder="e.g. 0917 123 4567" />
      <//>
      <${Field} label="Date started working">
        <input type="date" value=${started} onInput=${e => setStarted(e.target.value)} />
      <//>
      <button class="btn" disabled=${saving} onClick=${submit}>${saving ? 'Saving…' : (editId ? 'Update Employee' : 'Add Employee')}</button>
      ${editId && html`<button class="btn ghost" style="margin-top:8px" onClick=${reset}>Cancel edit</button>`}
    </div>

    <div class="card">
      <label>Personnel (${employees.length})</label>
      ${employees.length ? employees.map(e => html`
        <div class="row" key=${e.id}>
          <div>
            <div class="name">${e.name} <span class="mono" style="color:var(--ink-dim);font-weight:400">· ${e.code || '—'}</span></div>
            <div class="sub">${e.position || '—'}${e.phone ? ' · ' + e.phone : ''}${e.started_on ? ' · since ' + e.started_on : ''}</div>
            <div class="sub" style="color:var(--ink-dim)">Sick leave: ${e.sl_balance ?? 0} · Vacation: ${e.vl_balance ?? 0}</div>
          </div>
          <button class="ret" onClick=${() => edit(e)}>Edit</button>
        </div>`) : html`<div class="empty">No personnel yet.</div>`}
    </div>`;
}

// ---------- Vessel schedule ----------
const STATUS = [['drydock','Drydock'], ['afloat','Afloat repair'], ['emergency','Emergency repair'], ['not_active','Not active'], ['finished','Project finished']];
function Vessels({ voyages, sites, onReload, toast }) {
  const [vessel, setVessel] = useState('');
  const [vcode, setVcode] = useState('');
  const [siteId, setSiteId] = useState('');
  const [status, setStatus] = useState('drydock');
  const [docking, setDocking] = useState('');
  const [undocking, setUndocking] = useState('');
  const [departure, setDeparture] = useState('');
  const [afloatStart, setAfloatStart] = useState('');
  const [afloatDone, setAfloatDone] = useState('');
  const [emergStart, setEmergStart] = useState('');
  const [emergEnd, setEmergEnd] = useState('');
  const [notes, setNotes] = useState('');
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);

  const reset = () => { setVessel(''); setVcode(''); setSiteId(''); setStatus('drydock'); setDocking(''); setUndocking('');
    setDeparture(''); setAfloatStart(''); setAfloatDone(''); setEmergStart(''); setEmergEnd(''); setNotes(''); setEditId(null); };

  const submit = async () => {
    if (!vessel.trim()) { toast('Enter a vessel name', true); return; }
    setSaving(true);
    const row = {
      vessel_name: vessel.trim(), vessel_code: vcode.trim() || null, site_id: siteId || null, status,
      docking_date: docking || null, undocking_date: undocking || null, departure_date: departure || null,
      afloat_start: afloatStart || null, afloat_done: afloatDone || null,
      emergency_start: emergStart || null, emergency_end: emergEnd || null, notes: notes || null,
    };
    try {
      if (editId) { await updateVoyage(editId, row); toast('Schedule updated'); }
      else { await addVoyage(row); toast('Vessel scheduled'); }
      reset(); onReload();
    } catch (e) { toast('Error: ' + e.message, true); }
    finally { setSaving(false); }
  };

  const edit = (v) => {
    setEditId(v.id); setVessel(v.vessel_name); setVcode(v.vessel_code || ''); setSiteId(v.site_id || ''); setStatus(v.status || 'drydock');
    setDocking(v.docking_date || ''); setUndocking(v.undocking_date || ''); setDeparture(v.departure_date || '');
    setAfloatStart(v.afloat_start || ''); setAfloatDone(v.afloat_done || '');
    setEmergStart(v.emergency_start || ''); setEmergEnd(v.emergency_end || ''); setNotes(v.notes || '');
  };
  const remove = async (v) => {
    if (!confirm(`Delete schedule for "${v.vessel_name}"?`)) return;
    try { await deleteVoyage(v.id); toast('Deleted'); onReload(); }
    catch (e) { toast('Error: ' + e.message, true); }
  };

  const isDry = status === 'drydock';
  const isAfloat = status === 'afloat';
  const isEmergency = status === 'emergency';

  return html`
    <div class="card">
      <div class="two">
        <${Field} label="Vessel name">
          <input value=${vessel} onInput=${e => setVessel(e.target.value)} placeholder="e.g. MV SF Trinity" />
        <//>
        <${Field} label="Vessel code">
          <input value=${vcode} onInput=${e => setVcode(e.target.value)} placeholder="e.g. SFT-2026-01" />
        <//>
      </div>
      <div class="two">
        <${Field} label="Location">
          <select value=${siteId} onChange=${e => setSiteId(e.target.value)}>
            <option value="">Select…</option>
            ${sites.map(s => html`<option value=${s.id}>${s.name}</option>`)}
          </select>
        <//>
        <${Field} label="Status">
          <select value=${status} onChange=${e => setStatus(e.target.value)}>
            ${STATUS.map(([v, l]) => html`<option value=${v}>${l}</option>`)}
          </select>
        <//>
      </div>

      ${isDry && html`
        <div class="two">
          <${Field} label="Docking date"><input type="date" value=${docking} onInput=${e => setDocking(e.target.value)} /><//>
          <${Field} label="Undocking date"><input type="date" value=${undocking} onInput=${e => setUndocking(e.target.value)} /><//>
        </div>
        <${Field} label="Departure date"><input type="date" value=${departure} onInput=${e => setDeparture(e.target.value)} /><//>`}

      ${isAfloat && html`
        <div class="two">
          <${Field} label="Afloat start"><input type="date" value=${afloatStart} onInput=${e => setAfloatStart(e.target.value)} /><//>
          <${Field} label="Afloat end"><input type="date" value=${afloatDone} onInput=${e => setAfloatDone(e.target.value)} /><//>
        </div>`}

      ${isEmergency && html`
        <div class="two">
          <${Field} label="Emergency repair start"><input type="date" value=${emergStart} onInput=${e => setEmergStart(e.target.value)} /><//>
          <${Field} label="Emergency repair end"><input type="date" value=${emergEnd} onInput=${e => setEmergEnd(e.target.value)} /><//>
        </div>`}

      <${Field} label="Notes">
        <textarea rows="2" value=${notes} onInput=${e => setNotes(e.target.value)}></textarea>
      <//>
      <button class="btn" disabled=${saving} onClick=${submit}>${saving ? 'Saving…' : (editId ? 'Update Schedule' : 'Add to Schedule')}</button>
      ${editId && html`<button class="btn ghost" style="margin-top:8px" onClick=${reset}>Cancel edit</button>`}
    </div>

    <div class="card">
      <label>Vessel schedule (${voyages.length})</label>
      ${voyages.length ? voyages.map(v => html`
        <div class="row" key=${v.id}>
          <div>
            <div class="name">${v.vessel_name} ${v.vessel_code ? html`<span class="mono" style="color:var(--hivis);font-weight:600">${v.vessel_code}</span> ` : ''}<span class="pill">${(STATUS.find(s=>s[0]===v.status)||['','?'])[1]}</span></div>
            <div class="sub">${v.sites?.name || '—'}${v.undocking_date ? ' · undock ' + v.undocking_date : ''}${v.departure_date ? ' · departs ' + v.departure_date : ''}</div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="ret" onClick=${() => edit(v)}>Edit</button>
            <button class="ret" style="color:var(--warn)" onClick=${() => remove(v)}>✕</button>
          </div>
        </div>`) : html`<div class="empty">No vessels scheduled.</div>`}
    </div>`;
}

// ---------- Settings ----------
function Settings({ toast }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const save = () => {
    const admin = localStorage.getItem('rsr_admin_pin') || '1234';
    if (cur !== admin) { toast('Current PIN is wrong', true); return; }
    if (!next.trim()) { toast('Enter a new PIN', true); return; }
    localStorage.setItem('rsr_admin_pin', next.trim());
    setCur(''); setNext(''); toast('PIN changed');
  };
  return html`
    <div class="card">
      <${Field} label="Current PIN"><input type="password" value=${cur} onInput=${e => setCur(e.target.value)} /><//>
      <${Field} label="New PIN"><input type="password" value=${next} onInput=${e => setNext(e.target.value)} /><//>
      <button class="btn" onClick=${save}>Change PIN</button>
      <p class="note" style="margin-top:10px">The PIN is stored on this device. It's a light gate, not full security.</p>
    </div>`;
}

// ---------- App ----------
function FileLeave({ employees, toast }) {
  const [emp, setEmp] = useState('');
  const [type, setType] = useState('Sick Leave');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [recent, setRecent] = useState([]);
  const reload = () => getRecentLeaves().then(setRecent).catch(() => {});
  useEffect(() => { reload(); }, []);

  const picked = employees.find(e => e.code === emp);
  const bal = type === 'Sick Leave' ? (picked && picked.sl_balance) || 0
            : type === 'Vacation Leave' ? (picked && picked.vl_balance) || 0 : null;
  const hint = !picked ? '' :
    type === 'Leave Without Pay' ? 'LWP — unlimited, not counted as absent.'
    : type === 'Emergency Leave' ? 'Emergency leave — same day allowed.'
    : `Available: ${bal} day(s)` + (bal === 0 ? ' — exhausted, file LWP' : '');

  const submit = async () => {
    if (!emp) { toast('Select an employee', true); return; }
    if (!start || !end) { toast('Select dates', true); return; }
    const days = Math.ceil((new Date(end) - new Date(start)) / 86400000) + 1;
    if (days < 1) { toast('End date is before start', true); return; }
    if ((type === 'Sick Leave' || type === 'Vacation Leave') && bal < days) {
      toast(`Insufficient balance (${bal} day). File LWP instead.`, true); return;
    }
    setSaving(true);
    try {
      await fileLeave({ employee_code: emp, employee_name: picked.name, type, start_date: start,
        end_date: end, days, reason: reason.trim() || '', status: 'Pending', filed_by: 'Coordinator', filed_on: todayPH() });
      notifyTg(`📋 <b>Leave Request</b>\n👤 ${picked.name}\n📝 ${type}\n📅 ${start} → ${end} (${days} day${days !== 1 ? 's' : ''})\n💬 "${reason.trim()}"\n👩‍💼 Filed by: Coordinator`,
        [{ text: '✅ Approve', callback_data: 'approve_leave' }, { text: '❌ Reject', callback_data: 'reject_leave' }]);
      toast('Leave filed for ' + picked.name + ' — pending approval');
      setEmp(''); setReason(''); setStart(''); setEnd(''); reload();
    } catch (e) { toast('Error: ' + e.message, true); }
    finally { setSaving(false); }
  };

  return html`
    <div class="card">
      <label>File leave on behalf of an employee</label>
      <${Field} label="Employee">
        <select value=${emp} onChange=${e => setEmp(e.target.value)}>
          <option value="">Select employee…</option>
          ${employees.map(e => html`<option value=${e.code}>${e.name}${e.dept ? ' · ' + e.dept : ''}</option>`)}
        </select>
      <//>
      <${Field} label="Leave type">
        <select value=${type} onChange=${e => setType(e.target.value)}>
          <option>Sick Leave</option><option>Vacation Leave</option>
          <option>Leave Without Pay</option><option>Emergency Leave</option>
        </select>
      <//>
      ${hint && html`<p class="note" style="margin:-6px 0 12px;color:var(--ink-dim)">${hint}</p>`}
      <div class="two">
        <${Field} label="Start date"><input type="date" value=${start} onInput=${e => setStart(e.target.value)} /><//>
        <${Field} label="End date"><input type="date" value=${end} onInput=${e => setEnd(e.target.value)} /><//>
      </div>
      <${Field} label="Reason"><textarea rows="2" value=${reason} onInput=${e => setReason(e.target.value)} placeholder="Reason for leave…"></textarea><//>
      <button class="btn" disabled=${saving} onClick=${submit}>${saving ? 'Filing…' : 'Submit leave request'}</button>
    </div>
    <div class="card">
      <label>Recently filed</label>
      ${recent.length ? recent.map(r => html`
        <div class="row" key=${r.id} style="align-items:flex-start">
          <div><div class="name">${r.employee_name}</div>
            <div class="sub">${r.type} · ${r.start_date} → ${r.end_date} · ${r.days} day(s)</div>
            ${r.reason ? html`<div class="sub" style="color:var(--ink-dim)">"${r.reason}"</div>` : ''}</div>
          <span class="pill" style=${'background:' + (r.status === 'Approved' ? '#12B89E' : r.status === 'Rejected' ? '#D64045' : 'var(--hivis)') + ';color:#000'}>${r.status}</span>
        </div>`) : html`<div class="empty">No leaves filed yet.</div>`}
    </div>`;
}

function FileDuty({ employees, toast }) {
  const [emp, setEmp] = useState('');
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [recent, setRecent] = useState([]);
  const reload = () => getRecentDuties().then(setRecent).catch(() => {});
  useEffect(() => { reload(); }, []);

  const submit = async (breakType) => {
    const picked = employees.find(e => e.code === emp);
    if (!picked) { toast('Select an employee', true); return; }
    if (!date) { toast('Select a date', true); return; }
    if (!reason.trim()) { toast('Enter a reason', true); return; }
    const breakLabel = breakType === 'lunch' ? 'Lunch (12:00–1:00 PM)' : 'PM Break (5:00–6:00 PM)';
    setSaving(true);
    try {
      await fileDuty({ employee_code: emp, employee_name: picked.name, employee_dept: picked.dept || '—',
        break_type: breakType, break_label: breakLabel, date, reason: reason.trim(), status: 'Pending', filed_on: todayPH() });
      const emoji = breakType === 'lunch' ? '🍽️' : '☕';
      notifyTg(`${emoji} <b>Straight Duty Request</b>\n👤 ${picked.name}\n💼 ${picked.dept || '—'}\n📅 ${date}\n⏰ ${breakLabel}\n📝 "${reason.trim()}"`,
        [{ text: '✅ Approve', callback_data: 'approve_sd_' + breakType }, { text: '❌ Reject', callback_data: 'reject_sd_' + breakType }]);
      toast('Straight duty request sent');
      setEmp(''); setReason(''); reload();
    } catch (e) { toast('Error: ' + e.message, true); }
    finally { setSaving(false); }
  };

  return html`
    <div class="card">
      <label>File straight duty (emergency work during break)</label>
      <p class="note" style="margin:0 0 12px;color:var(--ink-dim)">Admin approves via Telegram.</p>
      <${Field} label="Employee">
        <select value=${emp} onChange=${e => setEmp(e.target.value)}>
          <option value="">Select employee…</option>
          ${employees.map(e => html`<option value=${e.code}>${e.name}${e.dept ? ' · ' + e.dept : ''}</option>`)}
        </select>
      <//>
      <${Field} label="Date"><input type="date" value=${date} onInput=${e => setDate(e.target.value)} /><//>
      <${Field} label="Reason"><textarea rows="2" value=${reason} onInput=${e => setReason(e.target.value)} placeholder="e.g. Emergency repair works"></textarea><//>
      <div class="two">
        <button class="btn" disabled=${saving} onClick=${() => submit('lunch')}>🍽️ Lunch straight duty</button>
        <button class="btn" disabled=${saving} onClick=${() => submit('pm')}>☕ PM straight duty</button>
      </div>
    </div>
    <div class="card">
      <label>Recent straight duties</label>
      ${recent.length ? recent.map(r => html`
        <div class="row" key=${r.id} style="align-items:flex-start">
          <div><div class="name">${r.break_type === 'lunch' ? '🍽️' : '☕'} ${r.employee_name}</div>
            <div class="sub">${r.break_label} · ${r.date}</div>
            ${r.reason ? html`<div class="sub" style="color:var(--ink-dim)">"${r.reason}"</div>` : ''}</div>
          <span class="pill" style=${'background:' + (r.status === 'Approved' ? '#12B89E' : r.status === 'Rejected' ? '#D64045' : 'var(--hivis)') + ';color:#000'}>${r.status}</span>
        </div>`) : html`<div class="empty">No straight duties filed yet.</div>`}
    </div>`;
}

function Expenses({ voyages, toast }) {
  const [voyage, setVoyage] = useState('');
  const [cat, setCat] = useState('Materials');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [paidBy, setPaidBy] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState([]);
  const reload = () => getExpenses().then(setRows).catch(() => {});
  useEffect(() => { reload(); }, []);

  const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const submit = async () => {
    if (!voyage) { toast('Select a vessel', true); return; }
    if (amount === '' || isNaN(Number(amount))) { toast('Enter an amount', true); return; }
    const v = voyages.find(x => x.id === voyage);
    setSaving(true);
    try {
      await addExpense({ voyage_id: voyage, vessel_name: v ? v.vessel_name : null, category: cat,
        amount: Number(amount), spent_on: date || null, paid_by: paidBy.trim() || null, note: note.trim() || null });
      toast('Expense added');
      setAmount(''); setNote(''); setPaidBy(''); setDate('');
      reload();
    } catch (e) { toast('Error: ' + e.message, true); }
    finally { setSaving(false); }
  };
  const remove = async (id) => {
    if (!confirm('Delete this expense?')) return;
    try { await deleteExpense(id); reload(); toast('Deleted'); } catch (e) { toast('Error: ' + e.message, true); }
  };

  // group by vessel
  const groups = {};
  rows.forEach(r => { const k = r.voyage_id || 'none'; if (!groups[k]) groups[k] = { name: r.vessel_name || 'Unassigned', items: [], total: 0 }; groups[k].items.push(r); groups[k].total += Number(r.amount) || 0; });
  const grand = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);

  return html`
    <div class="card">
      <label>Add a vessel expense</label>
      <${Field} label="Vessel / project">
        <select value=${voyage} onChange=${e => setVoyage(e.target.value)}>
          <option value="">— Select vessel —</option>
          ${voyages.map(v => html`<option value=${v.id}>${v.vessel_name}${v.vessel_code ? ' (' + v.vessel_code + ')' : ''}</option>`)}
        </select>
      <//>
      <div class="two">
        <${Field} label="Category">
          <select value=${cat} onChange=${e => setCat(e.target.value)}>
            <option>Materials</option><option>Labor</option><option>Equipment</option>
            <option>Subcontractor</option><option>Transport</option><option>Consumables</option><option>Other</option>
          </select>
        <//>
        <${Field} label="Amount ₱"><input type="number" min="0" step="0.01" value=${amount} onInput=${e => setAmount(e.target.value)} placeholder="0.00" /><//>
      </div>
      <div class="two">
        <${Field} label="Date"><input type="date" value=${date} onInput=${e => setDate(e.target.value)} /><//>
        <${Field} label="Paid by"><input value=${paidBy} onInput=${e => setPaidBy(e.target.value)} placeholder="Name" /><//>
      </div>
      <${Field} label="Note (optional)"><input value=${note} onInput=${e => setNote(e.target.value)} placeholder="What was it for?" /><//>
      <button class="btn" disabled=${saving} onClick=${submit}>${saving ? 'Saving…' : 'Add expense'}</button>
    </div>

    <div class="card">
      <label>Costs by vessel — total ${peso(grand)}</label>
      ${Object.keys(groups).length ? Object.values(groups).sort((a, b) => b.total - a.total).map(g => html`
        <div style="margin-bottom:14px">
          <div class="row" style="border-bottom:1px solid var(--line)"><div class="name">${g.name}</div><div class="name">${peso(g.total)}</div></div>
          ${g.items.map(r => html`
            <div class="row" key=${r.id} style="align-items:flex-start">
              <div><div class="sub"><b>${r.category || '—'}</b> · ${peso(r.amount)}</div>
                <div class="sub" style="color:var(--ink-dim)">${r.spent_on || '—'}${r.paid_by ? ' · ' + r.paid_by : ''}${r.note ? ' · ' + r.note : ''}</div></div>
              <button class="ret" onClick=${() => remove(r.id)}>✕</button>
            </div>`)}
        </div>`) : html`<div class="empty">No expenses logged yet.</div>`}
    </div>`;
}

function App() {
  const [authed, setAuthed] = useState(sessionStorage.getItem('rsr_coord') === '1');
  const [area, setArea] = useState(null);          // null | 'vessels' | 'personnel' | 'expenses'
  const [pdTab, setPdTab] = useState('personnel');  // personnel | leave | duty
  const [employees, setEmployees] = useState([]);
  const [voyages, setVoyages] = useState([]);
  const [sites, setSites] = useState([]);
  const [toast, setToast] = useState(null);
  const [fatal, setFatal] = useState(null);

  const flash = (msg, err = false) => { setToast({ msg, err }); setTimeout(() => setToast(null), 2600); };

  const loadEmployees = useCallback(async () => { try { setEmployees(await getEmployees()); } catch (e) { flash('Load failed: ' + e.message, true); } }, []);
  const loadVoyages = useCallback(async () => { try { setVoyages(await getVoyages()); } catch (e) { flash('Load failed: ' + e.message, true); } }, []);

  useEffect(() => { if (!authed) return; (async () => {
    try { setSites(await getSites()); loadEmployees(); loadVoyages(); }
    catch (e) { setFatal(e.message); }
  })(); }, [authed]);

  if (!authed) return html`
    <div class="wrap">
      <${Lock} onUnlock=${() => setAuthed(true)} toast=${flash} />
      ${toast && html`<div class=${'toast' + (toast.err?' err':'')}>${toast.msg}</div>`}
    </div>`;

  const Header = (title) => html`
    <header class="app">
      <div class="wrap"><div class="brand" style="display:flex;align-items:center;justify-content:space-between">
        <span><b>RSR</b><span class="tag">${title}</span></span>
        <span style="display:flex;gap:14px;align-items:center">
          ${area && html`<button onClick=${() => setArea(null)} style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">← Menu</button>`}
          <a href="../" onClick=${() => sessionStorage.removeItem('rsr_coord')} style="color:var(--ink-dim);text-decoration:none;font-size:13px;font-weight:700">⌂ Home</a>
        </span>
      </div></div>
    </header>`;

  // ---- landing: 3 tiles ----
  if (area === null) return html`
    ${Header('COORDINATOR')}
    <div class="wrap">
      ${fatal && html`<div class="card" style="border-color:var(--warn)"><div class="note" style="color:#ffc7c0">Couldn't reach Supabase: ${fatal}.</div></div>`}
      <label style="margin:4px 2px 12px">Choose an area</label>
      <div class="card" style="cursor:pointer" onClick=${() => setArea('vessels')}>
        <div style="font-size:26px">🚢</div><div class="name" style="font-size:18px;margin-top:6px">Vessel Schedule</div>
        <div class="sub">Dockings, status &amp; dates</div>
      </div>
      <div class="card" style="cursor:pointer" onClick=${() => { setArea('personnel'); setPdTab('personnel'); }}>
        <div style="font-size:26px">👷</div><div class="name" style="font-size:18px;margin-top:6px">Personnel Data</div>
        <div class="sub">Employees, leave &amp; straight duty</div>
      </div>
      <div class="card" style="cursor:pointer" onClick=${() => setArea('expenses')}>
        <div style="font-size:26px">💰</div><div class="name" style="font-size:18px;margin-top:6px">Expenses</div>
        <div class="sub">Per-vessel job costs</div>
      </div>
    </div>
    ${toast && html`<div class=${'toast' + (toast.err?' err':'')}>${toast.msg}</div>`}`;

  // ---- areas ----
  return html`
    ${Header(area === 'vessels' ? 'VESSEL SCHEDULE' : area === 'expenses' ? 'EXPENSES' : 'PERSONNEL DATA')}
    <div class="wrap">
      ${area === 'vessels' && html`<${Vessels} voyages=${voyages} sites=${sites} onReload=${loadVoyages} toast=${flash} />`}
      ${area === 'expenses' && html`<${Expenses} voyages=${voyages} toast=${flash} />`}
      ${area === 'personnel' && html`
        <div class="tabs">
          <button class=${pdTab==='personnel'?'on':''} onClick=${() => setPdTab('personnel')}>Personnel</button>
          <button class=${pdTab==='leave'?'on':''}     onClick=${() => setPdTab('leave')}>Leave</button>
          <button class=${pdTab==='duty'?'on':''}      onClick=${() => setPdTab('duty')}>Duty</button>
        </div>
        ${pdTab==='personnel' && html`<${Personnel} employees=${employees} onReload=${loadEmployees} toast=${flash} />`}
        ${pdTab==='leave' && html`<${FileLeave} employees=${employees} toast=${flash} />`}
        ${pdTab==='duty' && html`<${FileDuty} employees=${employees} toast=${flash} />`}
      `}
    </div>
    ${toast && html`<div class=${'toast' + (toast.err?' err':'')}>${toast.msg}</div>`}
  `;
}

render(html`<${App} />`, document.getElementById('app'));
