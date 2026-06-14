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
// ---------- liquidation ----------
async function getOpenFund() {
  const { data } = await supabase.from('liq_fund').select('*').eq('status', 'open').order('created_at', { ascending: false }).limit(1);
  return (data && data[0]) || null;
}
async function createFund(row) { const { error } = await supabase.from('liq_fund').insert(row); if (error) throw error; }
async function updateFund(id, fields) { const { error } = await supabase.from('liq_fund').update(fields).eq('id', id); if (error) throw error; }
async function getAdvances(fundId) { const { data, error } = await supabase.from('liq_advance').select('*').eq('fund_id', fundId).order('created_at', { ascending: false }); if (error) throw error; return data || []; }
async function addAdvance(row) { const { error } = await supabase.from('liq_advance').insert(row); if (error) throw error; }
async function delAdvance(id) { const { error } = await supabase.from('liq_advance').delete().eq('id', id); if (error) throw error; }
async function getLiqLines(fundId) { const { data, error } = await supabase.from('liq_line').select('*').eq('fund_id', fundId).order('created_at', { ascending: false }); if (error) throw error; return data || []; }
async function addLiqLine(row) { const { error } = await supabase.from('liq_line').insert(row); if (error) throw error; }
async function updateLiqLine(id, fields) { const { error } = await supabase.from('liq_line').update(fields).eq('id', id); if (error) throw error; }
async function delLiqLine(id) { const { error } = await supabase.from('liq_line').delete().eq('id', id); if (error) throw error; }
async function verifyPin(empId, pin) { const { data, error } = await supabase.rpc('verify_pin', { emp_id: empId, pin_input: pin }); if (error) throw error; return data === true; }
async function getPRs() { const { data, error } = await supabase.from('purchase_request').select('*').order('created_at', { ascending: false }).limit(300); if (error) throw error; return data || []; }
async function addPR(row) { const { error } = await supabase.from('purchase_request').insert(row); if (error) throw error; }
async function updatePR(id, fields) { const { error } = await supabase.from('purchase_request').update(fields).eq('id', id); if (error) throw error; }
async function getStockItems() { const { data, error } = await supabase.from('stock_item').select('*').order('name'); if (error) throw error; return data || []; }
async function addStockItem(row) { const { error } = await supabase.from('stock_item').insert(row); if (error) throw error; }
async function nextNo(prefix, site) {
  try { const { data, error } = await supabase.rpc('next_no', { p_prefix: prefix, p_site: site }); if (!error && data) return data; } catch (_) {}
  const n = new Date(), z = x => String(x).padStart(2, '0');
  return prefix + '-' + site + '-' + z(n.getHours()) + z(n.getMinutes()) + z(n.getSeconds());
}
const LIQ_SITE_CODES = { 'Carmen': 'CAR', 'Mandaue': 'MAN', 'Lapu-Lapu': 'LAP' };
const liqSiteCode = (s) => LIQ_SITE_CODES[s] || (s || 'GEN').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
// push leftover material into the site's stock (mirrors the material app's delivery)
async function liqStockIn(line, custodian) {
  const qty = Number(line.qty_to_stock) || 0; if (qty <= 0) return;
  const item = (line.item || '').trim();
  // update the on-hand stock first (this is what Material Issuance reads)
  const { data: cur } = await supabase.from('site_stock').select('qty').eq('site_key', line.site).eq('item_name', item).maybeSingle();
  const nq = (cur ? Number(cur.qty) || 0 : 0) + qty;
  const { error: e2 } = await supabase.from('site_stock').upsert({ site_key: line.site, item_name: item, qty: nq, updated_at: new Date().toISOString() }, { onConflict: 'site_key,item_name' });
  if (e2) throw e2;
  // delivery log is best-effort; never let it block the stock update
  try {
    const id = await nextNo('DLV', liqSiteCode(line.site));
    await supabase.from('deliveries').insert([{ id, site: line.site, source: 'Liquidation', ref: line.id,
      date: line.or_date || new Date().toISOString().slice(0, 10), received_by: custodian || 'Liquidation',
      items: [{ n: item, u: line.unit || 'pc', qty }], created_at: new Date().toISOString() }]);
  } catch (e) {}
  await updateLiqLine(line.id, { posted: true });
}
// register a bought tool into the Tools module (mirrors Setup → Register tool)
async function liqToolIn(line, siteId, prefix) {
  const qty = Math.max(1, parseInt(line.qty, 10) || 1);
  const pfx = (prefix || '').trim().toUpperCase(); if (!pfx) throw new Error('Code prefix required');
  if (!siteId) throw new Error('Site not found in sites table');
  const { data: un } = await supabase.from('item_units').select('unit_code').ilike('unit_code', pfx + '%');
  let max = 0; (un || []).forEach(u => { const n = parseInt((u.unit_code || '').slice(pfx.length), 10); if (!isNaN(n) && n > max) max = n; });
  const { data: item, error } = await supabase.from('items').insert({ item_code: pfx, name: line.item, unit: 'pcs', track_type: 'borrow', active: true }).select().single();
  if (error) throw error;
  const rows = []; for (let i = 1; i <= qty; i++) rows.push({ item_id: item.id, site_id: siteId, unit_code: pfx + String(max + i).padStart(3, '0'), status: 'available', active: true });
  const { error: e2 } = await supabase.from('item_units').insert(rows); if (e2) throw e2;
  await updateLiqLine(line.id, { posted: true });
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

      <label style="margin-top:6px">Drydock dates ${isDry ? '' : html`<span style="font-weight:400;color:var(--ink-dim)">(if applicable)</span>`}</label>
      <div class="two">
        <${Field} label="Docking date"><input type="date" value=${docking} onInput=${e => setDocking(e.target.value)} /><//>
        <${Field} label="Undocking date"><input type="date" value=${undocking} onInput=${e => setUndocking(e.target.value)} /><//>
      </div>
      <${Field} label="Departure date"><input type="date" value=${departure} onInput=${e => setDeparture(e.target.value)} /><//>

      <label style="margin-top:6px">Afloat repair dates <span style="font-weight:400;color:var(--ink-dim)">(if applicable)</span></label>
      <div class="two">
        <${Field} label="Afloat start"><input type="date" value=${afloatStart} onInput=${e => setAfloatStart(e.target.value)} /><//>
        <${Field} label="Afloat end"><input type="date" value=${afloatDone} onInput=${e => setAfloatDone(e.target.value)} /><//>
      </div>

      <label style="margin-top:6px">Emergency repair dates <span style="font-weight:400;color:var(--ink-dim)">(if applicable)</span></label>
      <div class="two">
        <${Field} label="Emergency repair start"><input type="date" value=${emergStart} onInput=${e => setEmergStart(e.target.value)} /><//>
        <${Field} label="Emergency repair end"><input type="date" value=${emergEnd} onInput=${e => setEmergEnd(e.target.value)} /><//>
      </div>

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

// ---------- Liquidation (cash advance, reconcile by project) ----------
const stepHead = (n, t, s) => html`
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
    <div style="width:30px;height:30px;border-radius:50%;background:var(--accent,#0f6e56);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;flex:0 0 30px">${n}</div>
    <div><div class="name" style="font-size:15px;font-weight:800">${t}</div>
    <div class="sub" style="font-size:12px;color:var(--ink-dim)">${s}</div></div>
  </div>`;
function Liquidation({ voyages, employees, sites, toast, tab, setTab }) {
  const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const uid = () => 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const today = () => new Date().toISOString().slice(0, 10);
  const bSm = 'padding:6px 12px;border:none;border-radius:8px;background:var(--accent,#0f6e56);color:#fff;font-size:13px;font-weight:700;cursor:pointer';
  const bSmAlt = 'padding:6px 12px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer';

  const [fund, setFund] = useState(undefined);
  const [advs, setAdvs] = useState([]);
  const [lines, setLines] = useState([]);
  const [matView, setMatView] = useState('request'); const [toolView, setToolView] = useState('request'); const [openPr, setOpenPr] = useState({});
  const [cust, setCust] = useState('Raffy');
  const [pfrom, setPfrom] = useState(today());
  const [aDate, setADate] = useState(today()); const [aAmt, setAAmt] = useState(''); const [aBy, setABy] = useState('Raffy'); const [aRem, setARem] = useState(''); const [aMode, setAMode] = useState('Cash'); const [aRef, setARef] = useState('');
  const [alDate, setAlDate] = useState(today()); const [alRec, setAlRec] = useState(''); const [alAmt, setAlAmt] = useState(''); const [alVes, setAlVes] = useState(''); const [alRem, setAlRem] = useState(''); const [alMode, setAlMode] = useState('Cash'); const [alRef, setAlRef] = useState('');
  const [pinVals, setPinVals] = useState({}); const [pinErr, setPinErr] = useState({}); const [pinModal, setPinModal] = useState(null);
  const [cDate, setCDate] = useState(today()); const [cAmt, setCAmt] = useState(''); const [cCharge, setCCharge] = useState('Project'); const [cVes, setCVes] = useState(''); const [cRem, setCRem] = useState('');
  const [mxDate, setMxDate] = useState(today()); const [mxCat, setMxCat] = useState('Clinic / Medical'); const [mxAmt, setMxAmt] = useState(''); const [mxEmp, setMxEmp] = useState(''); const [mxVes, setMxVes] = useState(''); const [mxOr, setMxOr] = useState(''); const [mxRem, setMxRem] = useState('');
  const [prs, setPrs] = useState([]); const [stockItems, setStockItems] = useState([]);
  const [prItems, setPrItems] = useState([]); const [prPick, setPrPick] = useState(''); const [prBy, setPrBy] = useState('Raffy');
  const [mDate, setMDate] = useState(today()); const [mPr, setMPr] = useState(''); const [buyRows, setBuyRows] = useState([]);
  const [mVes, setMVes] = useState(''); const [mSite, setMSite] = useState('Carmen'); const [mOr, setMOr] = useState(''); const [mRem, setMRem] = useState('');
  const [niOpen, setNiOpen] = useState(false); const [niName, setNiName] = useState(''); const [niUnit, setNiUnit] = useState('pcs');
  const [tDate, setTDate] = useState(today()); const [tItem, setTItem] = useState(''); const [tPfx, setTPfx] = useState(''); const [tUC, setTUC] = useState('');
  const [tQ, setTQ] = useState('1'); const [tSite, setTSite] = useState('Carmen'); const [tVes, setTVes] = useState(''); const [tOr, setTOr] = useState(''); const [tRem, setTRem] = useState('');
  const [toolPick, setToolPick] = useState(''); const [toolItems, setToolItems] = useState([]); const [tPr, setTPr] = useState(''); const [toolBuyRows, setToolBuyRows] = useState([]);
  const [busy, setBusy] = useState(false);

  // Vessel/division picker = only vessels currently in an ACTIVE repair phase.
  // Appears once a START date is encoded (docking / afloat start / emergency start)
  // and drops out the moment the MATCHING end date is encoded (undocking / afloat end / emergency end).
  const isActiveRepair = (v) => (v.docking_date && !v.undocking_date) || (v.afloat_start && !v.afloat_done) || (v.emergency_start && !v.emergency_end);
  const vessels = (voyages || []).filter(isActiveRepair).map(v => v.vessel_name).filter(Boolean);
  const tdy = today();
  const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);  // one day back
  const siteNames = (sites || []).length ? sites.map(s => s.name) : ['Carmen', 'Mandaue'];
  const loadRefs = async () => { try { setPrs(await getPRs()); setStockItems(await getStockItems()); } catch (e) { toast('Refs load failed: ' + e.message, true); } };
  const loadAll = async (f) => { if (!f) return; try { setAdvs(await getAdvances(f.id)); setLines(await getLiqLines(f.id)); } catch (e) { toast('Load failed: ' + e.message, true); } };
  useEffect(() => { (async () => { try { const f = await getOpenFund(); setFund(f); if (f) loadAll(f); loadRefs(); } catch (e) { setFund(null); toast('Load failed: ' + e.message, true); } })(); }, []);

  const startFund = async () => {
    setBusy(true);
    const row = { id: uid(), custodian: cust.trim() || '—', period_from: pfrom || null, period_to: null, status: 'open', created_at: new Date().toISOString() };
    try { await createFund(row); setFund(row); setAdvs([]); setLines([]); toast('Fund started'); } catch (e) { toast('Error: ' + e.message, true); } finally { setBusy(false); }
  };
  const renameCustodian = async () => {
    const nn = prompt('Custodian name', fund.custodian || ''); if (nn === null) return;
    const v = nn.trim(); if (!v) { toast('Name required', true); return; }
    try { await updateFund(fund.id, { custodian: v }); setFund({ ...fund, custodian: v }); toast('Custodian updated'); } catch (e) { toast('Error: ' + e.message, true); }
  };
  const addAdv = async () => {
    if (aAmt === '' || isNaN(Number(aAmt))) { toast('Enter an amount', true); return; }
    if (aMode === 'GCash' && !aRef.trim()) { toast('Enter the GCash transaction no.', true); return; }
    setBusy(true);
    const row = { id: uid(), fund_id: fund.id, date: aDate || today(), amount: Number(aAmt), received_by: aBy.trim() || null,
      mode: aMode, gcash_ref: aMode === 'GCash' ? aRef.trim() : null, remarks: aRem.trim() || null, created_at: new Date().toISOString() };
    try {
      let hint = false;
      try { await addAdvance(row); }
      catch (e) { if (/column|mode|gcash/i.test(e.message || '')) { const { mode, gcash_ref, ...rest } = row; await addAdvance(rest); hint = true; } else throw e; }
      setAAmt(''); setARem(''); setARef(''); loadAll(fund);
      toast(hint ? 'Advance added — run updated liquidation.sql to store the GCash details' : 'Advance added' + (aMode === 'GCash' ? ' (GCash)' : ''));
    } catch (e) { toast('Error: ' + e.message, true); } finally { setBusy(false); }
  };
  const addAllow = async () => {
    if (!alRec) { toast('Select a recipient', true); return; }
    if (alAmt === '' || isNaN(Number(alAmt))) { toast('Enter an amount', true); return; }
    if (!alVes) { toast('Vessel / division is required', true); return; }
    if (alMode === 'GCash' && !alRef.trim()) { toast('Enter the GCash transaction no.', true); return; }
    const emp = employees.find(e => e.id === alRec);
    setBusy(true);
    const row = { id: uid(), fund_id: fund.id, type: 'ALLOWANCE', or_date: alDate || today(), vessel_div: alVes, recipient: emp ? emp.name : alRec, emp_id: emp ? emp.id : null, amount: Number(alAmt),
      mode: alMode, gcash_ref: alMode === 'GCash' ? alRef.trim() : null, confirmed: false, deductible: 'Pending', remarks: alRem.trim() || null, created_at: new Date().toISOString() };
    try {
      let hint = false;
      try { await addLiqLine(row); }
      catch (e) { if (/column|mode|gcash/i.test(e.message || '')) { const { mode, gcash_ref, ...rest } = row; await addLiqLine(rest); hint = true; } else throw e; }
      setAlAmt(''); setAlRem(''); setAlRef(''); loadAll(fund);
      toast(hint ? 'Added — run updated liquidation.sql to store the GCash details' : 'Allowance added — awaiting passcode');
    } catch (e) { toast('Error: ' + e.message, true); } finally { setBusy(false); }
  };
  const confirmAllow = async (l) => {
    const pin = (pinVals[l.id] || '').trim(); if (!pin) return;
    const emp = employees.find(e => e.id === l.emp_id) || employees.find(e => e.name === l.recipient);
    if (!emp) { setPinErr({ ...pinErr, [l.id]: 'Employee not found' }); return; }
    try {
      const ok = await verifyPin(emp.id, pin);
      if (ok) { await updateLiqLine(l.id, { confirmed: true, confirmed_at: new Date().toISOString() }); setPinErr({ ...pinErr, [l.id]: '' }); setPinVals({ ...pinVals, [l.id]: '' }); setPinModal(null); loadAll(fund); toast('Allowance confirmed'); }
      else setPinErr({ ...pinErr, [l.id]: 'Wrong passcode for ' + l.recipient });
    } catch (e) { toast('Error: ' + e.message, true); }
  };
  const MISC_CATS = ['Clinic / Medical', 'Medicine', 'Transport', 'Supplies', 'Other'];
  const addMisc = async () => {
    if (mxAmt === '' || isNaN(Number(mxAmt)) || Number(mxAmt) <= 0) { toast('Enter an amount', true); return; }
    const emp = employees.find(e => e.id === mxEmp);
    setBusy(true);
    const row = { id: uid(), fund_id: fund.id, type: 'MISC', or_date: mxDate || today(), vessel_div: mxVes || null, site: 'Carmen',
      item: mxCat, amount: Number(mxAmt), recipient: emp ? emp.name : null, emp_id: emp ? emp.id : null,
      or_ref: mxOr.trim() || null, remarks: mxRem.trim() || null, created_at: new Date().toISOString() };
    try {
      await addLiqLine(row);
      setMxAmt(''); setMxOr(''); setMxRem(''); setMxEmp(''); loadAll(fund);
      toast('Expense added');
    } catch (e) { toast('Error: ' + e.message, true); } finally { setBusy(false); }
  };
  const setDeduct = async (l, val) => { try { await updateLiqLine(l.id, { deductible: val, decided_at: new Date().toISOString(), decided_by: 'Payroller' }); loadAll(fund); toast('Set ' + val); } catch (e) { toast('Error: ' + e.message, true); } };
  const addCons = async () => {
    if (cAmt === '' || isNaN(Number(cAmt))) { toast('Enter an amount', true); return; }
    if (cCharge === 'Project' && !cVes) { toast('Vessel required for Project charge', true); return; }
    setBusy(true);
    try { await addLiqLine({ id: uid(), fund_id: fund.id, type: 'CONSUMABLE', or_date: cDate || today(), amount: Number(cAmt), charge_to: cCharge, vessel_div: cCharge === 'Project' ? cVes : null, remarks: cRem.trim() || null, created_at: new Date().toISOString() }); setCAmt(''); setCRem(''); loadAll(fund); toast('Consumable added'); } catch (e) { toast('Error: ' + e.message, true); } finally { setBusy(false); }
  };
  const removeLine = async (l) => {
    if (l.posted && (l.type === 'TOOL' || Number(l.qty_to_stock) > 0)) { toast('Already pushed to ' + (l.type === 'TOOL' ? 'Tools' : 'site stock') + ' — adjust it there instead', true); return; }
    if (!confirm('Delete this line?')) return;
    try { await delLiqLine(l.id); loadAll(fund); toast('Deleted'); } catch (e) { toast('Error: ' + e.message, true); }
  };
  const removeAdv = async (id) => { if (!confirm('Delete this advance?')) return; try { await delAdvance(id); loadAll(fund); toast('Deleted'); } catch (e) { toast('Error: ' + e.message, true); } };

  // ---- purchase requests ----
  const createPR = async () => {
    if (!prItems.length) { toast('Add at least one material', true); return; }
    setBusy(true);
    try {
      const no = await nextNo('LPR', liqSiteCode('Carmen'));
      const row = { id: uid(), pr_no: no, requested_by: prBy.trim() || null, date: today(), status: 'Pending', items: prItems.join(', '), site: 'Carmen', created_at: new Date().toISOString() };
      try { await addPR(row); }
      catch (e) { if (/column/i.test(e.message || '')) { const { site, ...rest } = row; await addPR(rest); } else throw e; }
      setPrItems([]); setPrPick(''); loadRefs(); toast('PR created: ' + no);
    } catch (e) { toast('Error: ' + e.message, true); } finally { setBusy(false); }
  };
  const decidePR = async (p, status) => {
    // Passcode gate temporarily removed for initial data entry — restore later.
    try { await updatePR(p.id, { status, approved_by: 'Coordinator', approved_at: new Date().toISOString() }); loadRefs(); toast(p.pr_no + ' ' + status); } catch (e) { toast('Error: ' + e.message, true); }
  };
  const createToolPR = async () => {
    if (!toolItems.length) { toast('Add at least one tool', true); return; }
    setBusy(true);
    try {
      const no = await nextNo('LTR', liqSiteCode('Carmen'));
      const row = { id: uid(), pr_no: no, requested_by: prBy.trim() || null, date: today(), status: 'Pending', items: toolItems.join(', '), site: 'Carmen', created_at: new Date().toISOString() };
      try { await addPR(row); } catch (e) { if (/column/i.test(e.message || '')) { const { site, ...rest } = row; await addPR(rest); } else throw e; }
      setToolItems([]); setToolPick(''); loadRefs(); toast('Request created: ' + no);
    } catch (e) { toast('Error: ' + e.message, true); } finally { setBusy(false); }
  };
  const prSlip = (p) => {
    const open = !!openPr[p.id];
    const its = p.items ? p.items.split(',').map(s=>s.trim()).filter(Boolean) : [];
    const bg = p.status==='Approved'?'#1d9e75':p.status==='Rejected'?'#c0392b':p.status==='Bought'?'#2d6cdf':'#b8860b';
    return html`
    <div key=${p.id} style="border:1px solid var(--line);border-radius:10px;margin-top:8px;background:var(--panel,#161a22);overflow:hidden">
      <div onClick=${()=>setOpenPr(o=>({...o,[p.id]:!o[p.id]}))} style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;cursor:pointer">
        <span style="font-weight:700;font-size:14px">${open?'▾':'▸'} ${p.pr_no}</span>
        <span style="font-size:11px;font-weight:700;color:#fff;background:${bg};padding:2px 9px;border-radius:10px">${p.status}</span>
      </div>
      ${open ? html`<div style="padding:0 12px 10px">
        <div class="sub" style="margin:0 0 6px">${p.date||'—'} · Requested by ${p.requested_by||'—'}${p.site?' · '+p.site:''}</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          ${its.length?its.map((it,i)=>html`<tr><td style="width:22px;padding:3px 0;color:var(--ink-dim)">${i+1}.</td><td style="padding:3px 0">${it}</td></tr>`):html`<tr><td class="sub">No items</td></tr>`}
        </table>
        ${p.status==='Pending'?html`<div class="sub" style="margin-top:8px;font-style:italic">Awaiting admin approval</div>`:''}
      </div>`:''}
    </div>`;
  };
  const saveNewItem = async () => {
    if (!niName.trim()) { toast('Material name?', true); return; }
    const nm = niName.trim();
    try { await addStockItem({ id: uid(), name: nm, unit: niUnit.trim() || 'pcs', default_site: mSite }); setNiName(''); setNiOpen(false); await loadRefs(); if (!prItems.includes(nm)) setPrItems([...prItems, nm]); toast('Material added to request'); } catch (e) { toast('Error: ' + e.message, true); }
  };

  // ---- materials (STOCK_MATERIAL) ----
  const pushStock = async (l) => { try { await liqStockIn(l, fund.custodian); loadAll(fund); toast('Pushed to ' + l.site + ' stock'); } catch (e) { toast('Stock push failed: ' + e.message, true); } };
  const buyRequest = async () => {
    const pr = prs.find(p => p.pr_no === mPr);
    if (!pr) { toast('Select an approved request', true); return; }
    if (pr.status !== 'Approved') { toast('Request ' + pr.pr_no + ' is not approved', true); return; }
    if (pr.date && mDate && pr.date > mDate) { toast('OR date must be on/after the request date', true); return; }
    const buys = buyRows.filter(r => Number(r.qty) > 0 && Number(r.cost) > 0);
    if (!buys.length) { toast('Enter qty and price for at least one item', true); return; }
    setBusy(true);
    try {
      const dt = mDate || today(), orRef = mOr.trim() || null, ves = mVes || null, rem = mRem.trim() || null;
      const errs = [];
      for (const r of buys) {
        const qb = Number(r.qty), uc = Number(r.cost);
        const line = { id: uid(), fund_id: fund.id, type: 'STOCK_MATERIAL', or_date: dt, vessel_div: ves, site: mSite,
          item: r.name, unit: r.unit || 'pc', unit_cost: uc, qty_bought: qb, qty_used: 0, qty_to_stock: qb,
          pr_ref: pr.pr_no, or_ref: orRef, remarks: rem, posted: false, created_at: new Date().toISOString() };
        await addLiqLine(line);
        try { await liqStockIn(line, fund.custodian); } catch (e) { errs.push(r.name + ': ' + e.message); }
      }
      try { await updatePR(pr.id, { status: 'Bought' }); } catch (e) {}
      if (errs.length) toast('Stock update failed → ' + errs.join(' | '), true);
      else toast(buys.length + ' item(s) bought → ' + mSite + ' stock');
      setMPr(''); setBuyRows([]); setMOr(''); setMRem(''); setMVes('');
      loadAll(fund); loadRefs();
    } catch (e) { toast('Error: ' + e.message, true); } finally { setBusy(false); }
  };

  // ---- tools (TOOL) ----
  const pushTool = async (l) => {
    const sid = (sites || []).find(s => s.name === l.site); const pfx = ((l.remarks || '').match(/\[pfx:([A-Z0-9]+)\]/) || [])[1] || (l.item || '').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
    try { await liqToolIn(l, sid && sid.id, pfx); loadAll(fund); toast('Registered in Tools — ' + l.site); } catch (e) { toast('Tool push failed: ' + e.message, true); }
  };
  const addToolLine = async () => {
    if (!tItem.trim()) { toast('Tool name?', true); return; }
    const uc = Number(tUC), q = parseInt(tQ, 10);
    if (!(uc > 0)) { toast('Unit cost must be > 0', true); return; }
    if (!(q >= 1)) { toast('Qty must be at least 1', true); return; }
    const pfx = (tPfx || tItem.replace(/[^A-Za-z]/g, '').slice(0, 3)).toUpperCase();
    if (!pfx) { toast('Code prefix?', true); return; }
    const line = { id: uid(), fund_id: fund.id, type: 'TOOL', or_date: tDate || today(), vessel_div: tVes || null, site: tSite,
      item: tItem.trim(), unit: 'pcs', unit_cost: uc, qty: q, or_ref: tOr.trim() || null,
      remarks: ((tRem.trim() ? tRem.trim() + ' ' : '') + '[pfx:' + pfx + ']'), posted: false, created_at: new Date().toISOString() };
    setBusy(true);
    try {
      await addLiqLine(line);
      const sid = (sites || []).find(s => s.name === tSite);
      try { await liqToolIn(line, sid && sid.id, pfx); toast('Tool saved — registered in ' + tSite + ' Tools inventory'); }
      catch (e) { toast('Saved, but Tools push failed — use "Register" on the line', true); }
      setTItem(''); setTPfx(''); setTUC(''); setTQ('1'); setTOr(''); setTRem('');
      loadAll(fund);
    } catch (e) { toast('Error: ' + e.message, true); } finally { setBusy(false); }
  };
  const buyToolRequest = async () => {
    const pr = prs.find(p => p.pr_no === tPr);
    if (!pr) { toast('Select an approved request', true); return; }
    if (pr.status !== 'Approved') { toast('Request ' + pr.pr_no + ' is not approved', true); return; }
    if (pr.date && tDate && pr.date > tDate) { toast('OR date must be on/after the request date', true); return; }
    const buys = toolBuyRows.filter(r => (parseInt(r.qty,10)||0) > 0 && Number(r.cost) > 0);
    if (!buys.length) { toast('Enter qty and price for at least one tool', true); return; }
    setBusy(true);
    try {
      const dt = tDate || today(), orRef = tOr.trim() || null, ves = tVes || null, sid = (sites || []).find(s => s.name === tSite);
      let failed = 0;
      for (const r of buys) {
        const q = parseInt(r.qty,10)||0, uc = Number(r.cost), pfx = (r.prefix || r.name.replace(/[^A-Za-z]/g,'').slice(0,3)).toUpperCase();
        const line = { id: uid(), fund_id: fund.id, type: 'TOOL', or_date: dt, vessel_div: ves, site: tSite,
          item: r.name, unit: 'pcs', unit_cost: uc, qty: q, or_ref: orRef,
          remarks: ((tRem.trim() ? tRem.trim() + ' ' : '') + '[pfx:' + pfx + ']'), pr_ref: pr.pr_no, posted: false, created_at: new Date().toISOString() };
        await addLiqLine(line);
        try { await liqToolIn(line, sid && sid.id, pfx); } catch (e) { failed++; }
      }
      try { await updatePR(pr.id, { status: 'Bought' }); } catch (e) {}
      toast(buys.length + ' tool(s) bought → Tools inventory' + (failed ? ' (' + failed + ' need manual Register)' : ''));
      setTPr(''); setToolBuyRows([]); setTOr(''); setTRem(''); setTVes('');
      loadAll(fund); loadRefs();
    } catch (e) { toast('Error: ' + e.message, true); } finally { setBusy(false); }
  };

  const advance = advs.reduce((s, a) => s + Number(a.amount || 0), 0);
  let allow = 0, consProj = 0, consAdm = 0, matUsed = 0, stockVal = 0, toolVal = 0, misc = 0;
  lines.forEach(l => {
    if (l.type === 'ALLOWANCE') allow += Number(l.amount || 0);
    else if (l.type === 'CONSUMABLE') { if (l.charge_to === 'Project') consProj += Number(l.amount || 0); else consAdm += Number(l.amount || 0); }
    else if (l.type === 'STOCK_MATERIAL') { matUsed += Number(l.qty_used || 0) * Number(l.unit_cost || 0); stockVal += Number(l.qty_to_stock || 0) * Number(l.unit_cost || 0); }
    else if (l.type === 'TOOL') { toolVal += Number(l.qty || 0) * Number(l.unit_cost || 0); }
    else if (l.type === 'MISC') { misc += Number(l.amount || 0); }
  });
  const consumed = allow + consProj + consAdm + matUsed + misc;
  const onhand = stockVal + toolVal;
  const cashRet = advance - consumed - onhand;
  const cashOut = lines.reduce((s, l) => { if (l.type === 'STOCK_MATERIAL') return s + Number(l.qty_bought || 0) * Number(l.unit_cost || 0); if (l.type === 'TOOL') return s + Number(l.qty || 0) * Number(l.unit_cost || 0); return s + Number(l.amount || 0); }, 0);
  const balanceLeft = advance - cashOut;
  const perVessel = {};
  lines.forEach(l => { let amt = 0; if (l.type === 'ALLOWANCE') amt = Number(l.amount || 0); else if (l.type === 'CONSUMABLE' && l.charge_to === 'Project') amt = Number(l.amount || 0); else if (l.type === 'STOCK_MATERIAL') amt = Number(l.qty_used || 0) * Number(l.unit_cost || 0); else if (l.type === 'MISC') amt = Number(l.amount || 0); if (amt > 0 && l.vessel_div) perVessel[l.vessel_div] = (perVessel[l.vessel_div] || 0) + amt; });
  const perPerson = {};
  lines.filter(l => l.type === 'ALLOWANCE').forEach(l => { const k = l.recipient || '—'; if (!perPerson[k]) perPerson[k] = { total: 0, confirmed: 0 }; perPerson[k].total += Number(l.amount || 0); if (l.confirmed) perPerson[k].confirmed += Number(l.amount || 0); });

  if (fund === undefined) return html`<div class="card"><div class="empty">Loading…</div></div>`;
  if (fund === null) return html`
    <div class="card">
      <label>Start a liquidation fund</label>
      <p class="sub" style="margin:0 0 10px">One custodian fund over a period. Top it up with advances; reconcile by project.</p>
      <${Field} label="Custodian"><input value=${cust} onInput=${e => setCust(e.target.value)} placeholder="Name" /><//>
      <${Field} label="Period from"><input type="date" value=${pfrom} onInput=${e => setPfrom(e.target.value)} /><//>
      <button class="btn" disabled=${busy} onClick=${startFund}>${busy ? 'Starting…' : 'Start fund'}</button>
    </div>`;

  return html`
    <div class="card" style="background:var(--accent,#0f6e56);color:#fff">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <div><div style="font-size:12px;opacity:.85;text-transform:uppercase;letter-spacing:.5px">Cash on hand</div>
        <div style="font-size:24px;font-weight:800">${peso(balanceLeft)}</div></div>
        <div style="text-align:right;font-size:12px;opacity:.9">Custodian: ${fund.custodian} <button onClick=${renameCustodian} style="background:rgba(255,255,255,.22);border:none;color:#fff;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;cursor:pointer">✎ change</button><br/>Advance: ${peso(advance)}</div>
      </div>
    </div>
    ${tab === null && html`
      <label style="margin:4px 2px 10px;display:block">Liquidation</label>
      ${[
        { id:'fund',  ico:'💵', bg:'#e8f4ee', t:'Fund',        s:'Cash advances & top-ups · ' + peso(advance) },
        { id:'mat',   ico:'🧱', bg:'#fdeee4', t:'Materials',   s:'Request & buy stock materials' },
        { id:'tool',  ico:'🛠️', bg:'#e9eef8', t:'Tools',       s:'Request & buy tools' },
        { id:'allow', ico:'👷', bg:'#fdf3e0', t:'Allowance',   s:'Crew allowance · confirm by passcode' },
        { id:'cons',  ico:'🧾', bg:'#f0eafa', t:'Consumables', s:'Project & admin consumables' },
        { id:'misc',  ico:'🏥', bg:'#fde9ec', t:'Miscellaneous', s:'Clinic / medical & other expenses' },
        { id:'sum',   ico:'📊', bg:'#e6f2f5', t:'Summary',     s:'Reconciliation & totals' },
      ].map(x => html`
        <div class="card" key=${x.id} onClick=${() => setTab(x.id)}
          style="cursor:pointer;display:flex;align-items:center;gap:14px;padding:16px 14px;margin:0 0 12px">
          <div style=${'width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;flex:0 0 44px;background:'+x.bg}>${x.ico}</div>
          <div style="min-width:0">
            <div class="name" style="font-size:15px;font-weight:800">${x.t}</div>
            <div class="sub" style="font-size:12px;color:var(--ink-dim)">${x.s}</div>
          </div>
        </div>`)}
    `}

    ${tab === 'fund' && html`
      <div class="card">
        ${stepHead(1, 'Advance details', 'Date, amount & payment mode')}
        <div class="two"><${Field} label="Date"><input type="date" value=${aDate} onInput=${e=>setADate(e.target.value)} /><//>
        <${Field} label="Amount ₱"><input type="number" min="0" step="0.01" value=${aAmt} onInput=${e=>setAAmt(e.target.value)} placeholder="10000" /><//></div>
        <div class="two"><${Field} label="Mode"><select value=${aMode} onChange=${e=>setAMode(e.target.value)}><option>Cash</option><option>GCash</option></select><//>
        ${aMode==='GCash' ? html`<${Field} label="GCash transaction no."><input value=${aRef} onInput=${e=>setARef(e.target.value)} placeholder="ref no." /><//>` : html`<div></div>`}</div>
      </div>
      <div class="card">
        ${stepHead(2, 'Received by', 'Who received the cash, then save')}
        <${Field} label="Received by"><input value=${aBy} onInput=${e=>setABy(e.target.value)} /><//>
        <${Field} label="Remarks"><input value=${aRem} onInput=${e=>setARem(e.target.value)} placeholder="optional" /><//>
        <button class="btn" disabled=${busy} onClick=${addAdv}>Add advance</button>
      </div>
      <div class="card"><label>Advances — total ${peso(advance)}</label>
        ${advs.length ? advs.map(a => html`<div class="row" key=${a.id}><div><div class="name">${peso(a.amount)}</div><div class="sub">${a.date||'—'}${a.mode==='GCash'?' · GCash'+(a.gcash_ref?' #'+a.gcash_ref:''):' · '+(a.mode||'Cash')}${a.received_by?' · '+a.received_by:''}${a.remarks?' · '+a.remarks:''}</div></div><button class="ret" onClick=${()=>removeAdv(a.id)}>✕</button></div>`) : html`<div class="empty">No advances yet.</div>`}
      </div>`}

    ${tab === 'mat' && html`
      <div class="tabs" style="margin-bottom:10px">
        <button class=${matView==='request'?'on':''} onClick=${() => setMatView('request')}>Request</button>
        <button class=${matView==='buy'?'on':''} onClick=${() => setMatView('buy')}>Buy stock</button>
      </div>
      ${matView === 'request' ? html`
      <div class="card">
        ${stepHead(1, 'Request details', 'Who is requesting')}
        <${Field} label="Requested by"><input value=${prBy} onInput=${e=>setPrBy(e.target.value)} /><//>
      </div>
      <div class="card">
        ${stepHead(2, 'Items needed', 'Add the materials to request — no price yet')}
        <${Field} label="Add materials">
          <select value=${prPick} onChange=${e=>{const v=e.target.value; if(v && !prItems.includes(v)) setPrItems([...prItems, v]); setPrPick('');}}>
            <option value="">— add material —</option>
            ${stockItems.map(s=>html`<option value=${s.name}>${s.name}</option>`)}
          </select>
        <//>
        ${niOpen ? html`<div class="two"><${Field} label="New material name"><input value=${niName} onInput=${e=>setNiName(e.target.value)} /><//>
          <${Field} label="Unit"><input value=${niUnit} onInput=${e=>setNiUnit(e.target.value)} /><//></div>
          <div style="display:flex;gap:8px;margin-bottom:6px"><button style=${bSm} onClick=${saveNewItem}>Add to request</button><button style=${bSmAlt} onClick=${()=>setNiOpen(false)}>Cancel</button></div>`
        : html`<button style=${bSmAlt} onClick=${()=>setNiOpen(true)}>＋ New material (not in list)</button>`}
        ${prItems.length ? html`<div style="display:flex;flex-wrap:wrap;gap:6px;margin:6px 0">${prItems.map(it=>html`<span class="pill" style="display:inline-flex;align-items:center;gap:6px">${it}<span style="cursor:pointer;font-weight:700;color:var(--ink-dim)" onClick=${()=>setPrItems(prItems.filter(x=>x!==it))}>✕</span></span>`)}</div>` : html`<div class="sub" style="margin:4px 0">Pick materials (or add new ones) to build the request — no price needed yet.</div>`}
        <button class="btn" disabled=${busy} onClick=${createPR}>Create request</button>
      </div>
      <div class="card"><label>Request history</label>
        ${(()=>{const list=prs.filter(p=>!(p.pr_no||'').startsWith('LTR'));return list.length?list.slice(0,15).map(prSlip):html`<div class="empty">No requests yet.</div>`;})()}
      </div>` : ''}
      ${matView === 'buy' ? html`
      <div class="card">
        ${stepHead(1, 'Pick approved request', 'Only admin-approved requests appear here')}
        <${Field} label="Approved request">
          <select value=${mPr} onChange=${e=>{const no=e.target.value;setMPr(no);const p=prs.find(x=>x.pr_no===no);const names=p&&p.items?p.items.split(',').map(s=>s.trim()).filter(Boolean):[];setBuyRows(names.map(n=>{const s=stockItems.find(x=>x.name===n);return {name:n,unit:(s&&s.unit)||'pc',qty:'',cost:''};}));}}>
            <option value="">— select approved request —</option>
            ${prs.filter(p=>p.status==='Approved'&&!(p.pr_no||'').startsWith('LTR')).map(p=>html`<option value=${p.pr_no}>${p.pr_no} · ${p.items ? p.items.slice(0,40) : ''}</option>`)}
          </select>
        <//>
        ${mPr && buyRows.length ? '' : html`<div class="sub" style="margin:8px 0">Select an approved request to encode the purchase.</div>`}
      </div>
      ${mPr && buyRows.length ? html`
      <div class="card">
        ${stepHead(2, 'Encode qty & price', 'Real quantity bought and unit price per item')}
        ${buyRows.map((r,idx)=>html`
          <div key=${r.name} style="border:1px solid var(--line);border-radius:8px;padding:8px;margin-bottom:6px">
            <div style="font-weight:600;font-size:14px;margin-bottom:4px">${r.name} <span class="sub">(${r.unit})</span></div>
            <div class="two"><${Field} label="Qty bought"><input type="number" min="0" value=${r.qty} onInput=${e=>{const v=e.target.value;setBuyRows(buyRows.map((x,i)=>i===idx?{...x,qty:v}:x));}} /><//>
            <${Field} label="Unit price ₱"><input type="number" min="0" step="0.01" value=${r.cost} onInput=${e=>{const v=e.target.value;setBuyRows(buyRows.map((x,i)=>i===idx?{...x,cost:v}:x));}} /><//></div>
            <div class="sub">Line total: ₱${((Number(r.qty)||0)*(Number(r.cost)||0)).toLocaleString('en-PH')}</div>
          </div>`)}
      </div>
      <div class="card">
        ${stepHead(3, 'Receipt & save', 'Official receipt details, then save to stock')}
        <div class="two"><${Field} label="OR date"><input type="date" value=${mDate} min=${yday} max=${tdy} onInput=${e=>setMDate(e.target.value)} /><//>
        <${Field} label="Receipt no. (OR)"><input value=${mOr} onInput=${e=>setMOr(e.target.value)} placeholder="OR ref" /><//></div>
        <${Field} label="Vessel / division (optional)"><select value=${mVes} onChange=${e=>setMVes(e.target.value)}><option value="">— none —</option>${vessels.map(v=>html`<option>${v}</option>`)}</select><//>
        <${Field} label="Remarks"><input value=${mRem} onInput=${e=>setMRem(e.target.value)} placeholder="optional" /><//>
        <div class="sub" style="margin:2px 0 6px">Total to ${mSite} stock: ₱${buyRows.reduce((a,r)=>a+(Number(r.qty)||0)*(Number(r.cost)||0),0).toLocaleString('en-PH')}</div>
        <button class="btn" disabled=${busy} onClick=${buyRequest}>Save purchase → stock</button>
      </div>` : ''}
      <div class="card"><label>Material lines</label>
        ${lines.filter(l=>l.type==='STOCK_MATERIAL').length ? lines.filter(l=>l.type==='STOCK_MATERIAL').map(l => html`
          <div class="row" key=${l.id} style="align-items:flex-start;flex-direction:column;gap:4px">
            <div style="display:flex;justify-content:space-between;width:100%">
              <div><div class="name" style="font-size:14px">${l.item} · ${l.qty_bought} ${l.unit} @ ${peso(l.unit_cost)}</div>
                <div class="sub">${l.or_date||'—'} · ${l.pr_ref||'no PR'} · ${l.vessel_div||'—'} · ${l.site}${l.or_ref?'':' · '}${l.or_ref?'':html`<b style="color:var(--bad,#b0322a)">⚠ no receipt</b>`}</div></div>
              <button class="ret" onClick=${()=>removeLine(l)}>✕</button>
            </div>
            <div class="sub">${Number(l.qty_used)>0?('Used '+l.qty_used+' = '+peso(Number(l.qty_used)*Number(l.unit_cost))+' · '):''}To stock ${l.qty_to_stock} = ${peso(Number(l.qty_to_stock)*Number(l.unit_cost))}
              ${Number(l.qty_to_stock)>0 ? (l.posted ? html` · <b style="color:var(--accent2,#1d9e75)">✓ in ${l.site} stock</b>` : html` · <button style=${bSm} onClick=${()=>pushStock(l)}>Push to stock</button>`) : ''}</div>
          </div>`) : html`<div class="empty">None yet.</div>`}
      </div>` : ''}`}

    ${tab === 'tool' && html`
      <div class="tabs" style="margin-bottom:10px">
        <button class=${toolView==='request'?'on':''} onClick=${() => setToolView('request')}>Request</button>
        <button class=${toolView==='buy'?'on':''} onClick=${() => setToolView('buy')}>Buy tool</button>
      </div>
      ${toolView === 'request' ? html`
      <div class="card">
        ${stepHead(1, 'Request details', 'Who is requesting')}
        <${Field} label="Requested by"><input value=${prBy} onInput=${e=>setPrBy(e.target.value)} /><//>
      </div>
      <div class="card">
        ${stepHead(2, 'Tools needed', 'Type tool names — no price yet')}
        <${Field} label="Add tools">
          <input value=${toolPick} onInput=${e=>setToolPick(e.target.value)} onKeyDown=${e=>{if(e.key==='Enter'){e.preventDefault();const v=toolPick.trim();if(v&&!toolItems.includes(v))setToolItems([...toolItems,v]);setToolPick('');}}} placeholder="type a tool name" />
        <//>
        <div style="margin:6px 0"><button style=${bSm} onClick=${()=>{const v=toolPick.trim();if(v&&!toolItems.includes(v))setToolItems([...toolItems,v]);setToolPick('');}}>＋ Add tool</button></div>
        ${toolItems.length?html`<div style="display:flex;flex-wrap:wrap;gap:6px;margin:6px 0">${toolItems.map(it=>html`<span class="pill" style="display:inline-flex;align-items:center;gap:6px">${it}<span style="cursor:pointer;font-weight:700;color:var(--ink-dim)" onClick=${()=>setToolItems(toolItems.filter(x=>x!==it))}>✕</span></span>`)}</div>`:html`<div class="sub" style="margin:4px 0">Add the tools you need — no price yet.</div>`}
        <button class="btn" disabled=${busy} onClick=${createToolPR}>Create request</button>
      </div>
      <div class="card"><label>Request history</label>
        ${(()=>{const list=prs.filter(p=>(p.pr_no||'').startsWith('LTR'));return list.length?list.slice(0,15).map(prSlip):html`<div class="empty">No requests yet.</div>`;})()}
      </div>` : ''}
      ${toolView === 'buy' ? html`
      <div class="card">
        ${stepHead(1, 'Pick approved request', 'Only admin-approved tool requests appear here')}
        <${Field} label="Approved request">
          <select value=${tPr} onChange=${e=>{const no=e.target.value;setTPr(no);const p=prs.find(x=>x.pr_no===no);const names=p&&p.items?p.items.split(',').map(s=>s.trim()).filter(Boolean):[];setToolBuyRows(names.map(n=>({name:n,prefix:n.replace(/[^A-Za-z]/g,'').slice(0,3).toUpperCase(),qty:'1',cost:''})));}}>
            <option value="">— select approved request —</option>
            ${prs.filter(p=>p.status==='Approved'&&(p.pr_no||'').startsWith('LTR')).map(p=>html`<option value=${p.pr_no}>${p.pr_no} · ${p.items ? p.items.slice(0,40) : ''}</option>`)}
          </select>
        <//>
        ${tPr && toolBuyRows.length ? '' : html`<div class="sub" style="margin:8px 0">Select an approved request to encode the purchase.</div>`}
      </div>
      ${tPr && toolBuyRows.length ? html`
      <div class="card">
        ${stepHead(2, 'Encode qty & price', 'Code prefix, quantity and unit price per tool')}
        ${toolBuyRows.map((r,idx)=>html`
          <div key=${r.name} style="border:1px solid var(--line);border-radius:8px;padding:8px;margin-bottom:6px">
            <div style="font-weight:600;font-size:14px;margin-bottom:4px">${r.name}</div>
            <div class="two"><${Field} label="Code prefix"><input value=${r.prefix} onInput=${e=>{const v=e.target.value.toUpperCase();setToolBuyRows(toolBuyRows.map((x,i)=>i===idx?{...x,prefix:v}:x));}} /><//>
            <${Field} label="Qty"><input type="number" min="1" value=${r.qty} onInput=${e=>{const v=e.target.value;setToolBuyRows(toolBuyRows.map((x,i)=>i===idx?{...x,qty:v}:x));}} /><//></div>
            <${Field} label="Unit price ₱"><input type="number" min="0" step="0.01" value=${r.cost} onInput=${e=>{const v=e.target.value;setToolBuyRows(toolBuyRows.map((x,i)=>i===idx?{...x,cost:v}:x));}} /><//>
            <div class="sub">Line total: ₱${((parseInt(r.qty,10)||0)*(Number(r.cost)||0)).toLocaleString('en-PH')}</div>
          </div>`)}
      </div>
      <div class="card">
        ${stepHead(3, 'Receipt & save', 'Official receipt details, then register the tools')}
        <div class="two"><${Field} label="OR date"><input type="date" value=${tDate} min=${yday} max=${tdy} onInput=${e=>setTDate(e.target.value)} /><//>
        <${Field} label="Receipt no. (OR)"><input value=${tOr} onInput=${e=>setTOr(e.target.value)} placeholder="OR ref" /><//></div>
        <div class="two"><${Field} label="Site"><select value=${tSite} onChange=${e=>setTSite(e.target.value)}>${siteNames.map(s=>html`<option>${s}</option>`)}</select><//>
        <${Field} label="For job (optional)"><select value=${tVes} onChange=${e=>setTVes(e.target.value)}><option value="">—</option>${vessels.map(v=>html`<option>${v}</option>`)}</select><//></div>
        <${Field} label="Remarks"><input value=${tRem} onInput=${e=>setTRem(e.target.value)} placeholder="optional" /><//>
        <div class="sub" style="margin:2px 0 6px">Total tool value ₱${toolBuyRows.reduce((a,r)=>a+(parseInt(r.qty,10)||0)*(Number(r.cost)||0),0).toLocaleString('en-PH')} → on-hand asset</div>
        <button class="btn" disabled=${busy} onClick=${buyToolRequest}>Save purchase → Tools</button>
      </div>` : ''}
      <div class="card"><label>Tool lines</label>
        ${lines.filter(l=>l.type==='TOOL').length ? lines.filter(l=>l.type==='TOOL').map(l => html`
          <div class="row" key=${l.id} style="align-items:flex-start">
            <div><div class="name" style="font-size:14px">${l.item} ×${l.qty} @ ${peso(l.unit_cost)} = ${peso(Number(l.qty)*Number(l.unit_cost))}</div>
              <div class="sub">${l.or_date||'—'} · ${l.site}${l.vessel_div?' · '+l.vessel_div:''}${l.or_ref?'':' · '}${l.or_ref?'':html`<b style="color:var(--bad,#b0322a)">⚠ no receipt</b>`}</div>
              <div class="sub">${l.posted ? html`<b style="color:var(--accent2,#1d9e75)">✓ in Tools inventory (${l.site})</b>` : html`<button style=${bSm} onClick=${()=>pushTool(l)}>Register in Tools</button>`}</div></div>
            <button class="ret" onClick=${()=>removeLine(l)}>✕</button>
          </div>`) : html`<div class="empty">None yet.</div>`}
      </div>` : ''}`}

    ${tab === 'allow' && html`
      <div class="card">
        ${stepHead(1, 'Allowance details', 'Date, amount & payment mode')}
        <div class="two"><${Field} label="Date"><input type="date" value=${alDate} onInput=${e=>setAlDate(e.target.value)} /><//>
        <${Field} label="Amount ₱"><input type="number" min="0" step="0.01" value=${alAmt} onInput=${e=>setAlAmt(e.target.value)} placeholder="150" /><//></div>
        <div class="two"><${Field} label="Mode"><select value=${alMode} onChange=${e=>setAlMode(e.target.value)}><option>Cash</option><option>GCash</option></select><//>
        ${alMode==='GCash' ? html`<${Field} label="GCash transaction no."><input value=${alRef} onInput=${e=>setAlRef(e.target.value)} placeholder="ref no." /><//>` : html`<div></div>`}</div>
      </div>
      <div class="card">
        ${stepHead(2, 'Recipient', 'One row per person — they confirm by passcode')}
        <${Field} label="Recipient"><select value=${alRec} onChange=${e=>setAlRec(e.target.value)}><option value="">— select person —</option>${employees.map(e=>html`<option value=${e.id}>${e.name}</option>`)}</select><//>
        <${Field} label="Vessel / division"><select value=${alVes} onChange=${e=>setAlVes(e.target.value)}><option value="">— select —</option>${vessels.map(v=>html`<option>${v}</option>`)}</select><//>
        <${Field} label="Remarks"><input value=${alRem} onInput=${e=>setAlRem(e.target.value)} placeholder="optional" /><//>
        <button class="btn" disabled=${busy} onClick=${addAllow}>Add allowance row</button>
      </div>
      <div class="card"><label>Allowance rows — total ${peso(allow)}</label>
        ${lines.filter(l=>l.type==='ALLOWANCE').length ? lines.filter(l=>l.type==='ALLOWANCE').map(l => html`
          <div class="row" key=${l.id} style="align-items:flex-start;flex-direction:column;gap:6px">
            <div style="display:flex;justify-content:space-between;width:100%">
              <div><div class="name">${l.recipient} · ${peso(l.amount)}</div><div class="sub">${l.or_date||'—'} · ${l.vessel_div||'—'}${l.mode==='GCash'?' · GCash'+(l.gcash_ref?' #'+l.gcash_ref:''):''}</div></div>
              <button class="ret" onClick=${()=>removeLine(l)}>✕</button>
            </div>
            ${l.confirmed ? html`<div class="sub" style="color:var(--accent2,#1d9e75);font-weight:700">✓ Confirmed${l.confirmed_at?' · '+l.confirmed_at.slice(0,10):''}</div>
              <div style="display:flex;gap:6px;align-items:center"><span class="sub">Deductible:</span>
                ${l.deductible==='Pending' ? html`<button style=${bSm} onClick=${()=>setDeduct(l,'Yes')}>Yes</button><button style=${bSmAlt} onClick=${()=>setDeduct(l,'No')}>No</button>` : html`<b class="sub">${l.deductible}</b><button style=${bSmAlt} onClick=${()=>setDeduct(l,'Pending')}>change</button>`}
              </div>`
            : html`<button style=${bSm} onClick=${()=>{setPinErr({...pinErr,[l.id]:''});setPinModal(l.id);}}>Enter passcode →</button>`}
          </div>`) : html`<div class="empty">No allowance rows yet.</div>`}
      </div>
      ${pinModal ? (()=>{const l=lines.find(x=>x.id===pinModal);if(!l)return '';return html`
        <div onClick=${()=>setPinModal(null)} style="position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:50;padding:16px">
          <div onClick=${e=>e.stopPropagation()} style="background:var(--panel,#161a22);border:1px solid var(--line);border-radius:14px;padding:18px;max-width:340px;width:100%">
            <div style="font-weight:800;font-size:15px;margin-bottom:2px">Confirm allowance</div>
            <div class="sub" style="margin-bottom:10px">Have ${l.recipient} enter their passcode privately, then pass the phone to the next person.</div>
            <div style="display:flex;justify-content:space-between;align-items:center;border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:12px"><span>${l.recipient}</span><b style="font-size:16px">${peso(l.amount)}</b></div>
            <input type="password" inputmode="numeric" autofocus placeholder="passcode" value=${pinVals[l.id]||''} onInput=${e=>setPinVals({...pinVals,[l.id]:e.target.value})} style="width:100%;box-sizing:border-box;margin-bottom:8px" />
            ${pinErr[l.id] ? html`<div class="sub" style="color:var(--bad,#b0322a);margin-bottom:8px">${pinErr[l.id]}</div>` : ''}
            <div style="display:flex;gap:8px"><button class="btn" style="flex:1" disabled=${busy} onClick=${()=>confirmAllow(l)}>Confirm</button><button style=${bSmAlt} onClick=${()=>setPinModal(null)}>Cancel</button></div>
          </div>
        </div>`;})() : ''}`}

    ${tab === 'cons' && html`
      <div class="card">
        ${stepHead(1, 'Expense details', 'Date & amount (tubig, food, fuel)')}
        <div class="two"><${Field} label="Date"><input type="date" value=${cDate} onInput=${e=>setCDate(e.target.value)} /><//>
        <${Field} label="Amount ₱"><input type="number" min="0" step="0.01" value=${cAmt} onInput=${e=>setCAmt(e.target.value)} placeholder="0.00" /><//></div>
      </div>
      <div class="card">
        ${stepHead(2, 'Charge & save', 'Where to charge it, then save')}
        <${Field} label="Charge to"><select value=${cCharge} onChange=${e=>setCCharge(e.target.value)}><option>Project</option><option>Admin</option></select><//>
        ${cCharge==='Project' && html`<${Field} label="Vessel / division"><select value=${cVes} onChange=${e=>setCVes(e.target.value)}><option value="">— select —</option>${vessels.map(v=>html`<option>${v}</option>`)}</select><//>`}
        <${Field} label="Remarks"><input value=${cRem} onInput=${e=>setCRem(e.target.value)} placeholder="optional" /><//>
        <button class="btn" disabled=${busy} onClick=${addCons}>Add consumable</button>
      </div>
      <div class="card"><label>Consumables — Project ${peso(consProj)} · Admin ${peso(consAdm)}</label>
        ${lines.filter(l=>l.type==='CONSUMABLE').length ? lines.filter(l=>l.type==='CONSUMABLE').map(l => html`<div class="row" key=${l.id}><div><div class="name">${peso(l.amount)} · ${l.charge_to}</div><div class="sub">${l.or_date||'—'}${l.vessel_div?' · '+l.vessel_div:''}${l.remarks?' · '+l.remarks:''}</div></div><button class="ret" onClick=${()=>removeLine(l)}>✕</button></div>`) : html`<div class="empty">No consumables yet.</div>`}
      </div>`}

    ${tab === 'misc' && html`
      <div class="card">
        ${stepHead(1, 'Expense details', 'Date, amount & category')}
        <div class="two"><${Field} label="Date"><input type="date" value=${mxDate} max=${tdy} onInput=${e=>setMxDate(e.target.value)} /><//>
        <${Field} label="Amount ₱"><input type="number" min="0" step="0.01" value=${mxAmt} onInput=${e=>setMxAmt(e.target.value)} placeholder="0" /><//></div>
        <${Field} label="Category"><select value=${mxCat} onChange=${e=>setMxCat(e.target.value)}>${MISC_CATS.map(c=>html`<option>${c}</option>`)}</select><//>
      </div>
      <div class="card">
        ${stepHead(2, 'Charge & reference', 'Person, vessel, receipt & remarks, then save')}
        <${Field} label="For (person, optional)"><select value=${mxEmp} onChange=${e=>setMxEmp(e.target.value)}><option value="">—</option>${employees.map(e=>html`<option value=${e.id}>${e.name}</option>`)}</select><//>
        <${Field} label="Vessel / division (optional)"><select value=${mxVes} onChange=${e=>setMxVes(e.target.value)}><option value="">—</option>${vessels.map(v=>html`<option>${v}</option>`)}</select><//>
        <${Field} label="Receipt no. (OR)"><input value=${mxOr} onInput=${e=>setMxOr(e.target.value)} placeholder="OR ref" /><//>
        <${Field} label="Remarks"><input value=${mxRem} onInput=${e=>setMxRem(e.target.value)} placeholder="e.g. first-aid at clinic" /><//>
        <button class="btn" disabled=${busy} onClick=${addMisc}>Add expense</button>
      </div>
      <div class="card"><label>Miscellaneous expenses — total ${peso(misc)}</label>
        ${lines.filter(l=>l.type==='MISC').length ? lines.filter(l=>l.type==='MISC').map(l => html`
          <div class="row" key=${l.id} style="align-items:flex-start">
            <div><div class="name" style="font-size:14px">${l.item} · ${peso(l.amount)}</div>
              <div class="sub">${l.or_date||'—'}${l.recipient?' · '+l.recipient:''}${l.vessel_div?' · '+l.vessel_div:''}${l.or_ref?'':' · '}${l.or_ref?'':html`<b style="color:var(--bad,#b0322a)">⚠ no receipt</b>`}${l.remarks?' · '+l.remarks:''}</div></div>
            <button class="ret" onClick=${()=>removeLine(l)}>✕</button>
          </div>`) : html`<div class="empty">No expenses yet.</div>`}
      </div>`}
    ${tab === 'sum' && html`
      <div class="card">
        <label>Reconciliation</label>
        <div class="row"><div class="sub">Advance total</div><div class="name">${peso(advance)}</div></div>
        <div class="row"><div class="sub">Consumed</div><div class="name">${peso(consumed)}</div></div>
        ${misc>0?html`<div class="row"><div class="sub" style="padding-left:10px">• Miscellaneous (clinic / other)</div><div class="name">${peso(misc)}</div></div>`:''}
        <div class="row"><div class="sub">On-hand assets — stock ${peso(stockVal)} · tools ${peso(toolVal)}</div><div class="name">${peso(onhand)}</div></div>
        <div class="row" style="border-top:1px solid var(--line)"><div class="sub"><b>Cash that should be returned</b></div><div class="name">${peso(cashRet)}</div></div>
        ${cashRet < -0.005 ? html`<div class="note" style="color:var(--bad,#b0322a);font-weight:700;margin-top:8px">⚠ Overspent by ${peso(Math.abs(cashRet))} — fund short / missing top-up.</div>`
          : html`<div class="note" style="color:var(--accent2,#1d9e75);font-weight:700;margin-top:8px">✓ Balanced — advance = consumed + on-hand + cash returned.</div>`}
      </div>
      <div class="card"><label>Project cost per vessel</label>
        ${Object.keys(perVessel).length ? Object.keys(perVessel).sort((a,b)=>perVessel[b]-perVessel[a]).map(v=>html`<div class="row" key=${v}><div class="sub">${v}</div><div class="name">${peso(perVessel[v])}</div></div>`) : html`<div class="empty">No project costs yet.</div>`}
        <div class="row" style="border-top:1px solid var(--line)"><div class="sub">Overhead (Admin)</div><div class="name">${peso(consAdm)}</div></div>
      </div>
      <div class="card"><label>Allowance per person</label>
        ${Object.keys(perPerson).length ? Object.keys(perPerson).map(p=>html`<div class="row" key=${p}><div class="sub">${p}</div><div class="name">${peso(perPerson[p].confirmed)} / ${peso(perPerson[p].total)}</div></div>`) : html`<div class="empty">No allowances yet.</div>`}
      </div>
      <div class="card"><label>On-hand assets (must exist physically)</label>
        ${lines.filter(l=>(l.type==='STOCK_MATERIAL'&&Number(l.qty_to_stock)>0)||l.type==='TOOL').length
          ? lines.filter(l=>(l.type==='STOCK_MATERIAL'&&Number(l.qty_to_stock)>0)||l.type==='TOOL').map(l=>html`
            <div class="row" key=${l.id}><div class="sub">${l.type==='TOOL'?'🔧':'📦'} ${l.item} · ${l.type==='TOOL'?l.qty:l.qty_to_stock} ${l.unit} · ${l.site}</div>
            <div class="sub">${l.posted?html`<b style="color:var(--accent2,#1d9e75)">✓ recorded</b>`:html`<b style="color:var(--bad,#b0322a)">⚠ not pushed</b>`}</div></div>`)
          : html`<div class="empty">No on-hand assets.</div>`}
      </div>`}
  `;
}

function App() {
  const [authed, setAuthed] = useState(sessionStorage.getItem('rsr_coord') === '1');
  const [area, setArea] = useState(null);          // null | 'vessels' | 'personnel' | 'expenses'
  const [liqTab, setLiqTab] = useState(null);       // null (menu) | fund | mat | tool | allow | cons | misc | sum
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
          ${area === 'liquidation' && liqTab && html`<button onClick=${() => setLiqTab(null)} style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">← Liquidation menu</button>`}
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
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="card" style="cursor:pointer;margin:0" onClick=${() => setArea('vessels')}>
          <div style="font-size:24px">🚢</div><div class="name" style="font-size:15px;margin-top:6px;font-weight:700">Vessel Schedule</div>
          <div class="sub" style="font-size:12px;color:var(--ink-dim)">Dockings, status & dates</div>
        </div>
        <div class="card" style="cursor:pointer;margin:0" onClick=${() => { setArea('personnel'); setPdTab('personnel'); }}>
          <div style="font-size:24px">👷</div><div class="name" style="font-size:15px;margin-top:6px;font-weight:700">Personnel Data</div>
          <div class="sub" style="font-size:12px;color:var(--ink-dim)">Employees, leave & straight duty</div>
        </div>
        <div class="card" style="cursor:pointer;margin:0;grid-column:1/-1" onClick=${() => { setArea('liquidation'); setLiqTab(null); }}>
          <div style="font-size:24px">💰</div><div class="name" style="font-size:15px;margin-top:6px;font-weight:700">Liquidation</div>
          <div class="sub" style="font-size:12px;color:var(--ink-dim)">Cash advance · materials · tools · reconcile by project</div>
        </div>
      </div>
    </div>
    ${toast && html`<div class=${'toast' + (toast.err?' err':'')}>${toast.msg}</div>`}`;

  // ---- areas ----
  return html`
    ${Header(area === 'vessels' ? 'VESSEL SCHEDULE' : area === 'expenses' ? 'EXPENSES' : area === 'liquidation' ? ('LIQUIDATION' + (liqTab ? ' · ' + (liqTab==='fund'?'FUND':liqTab==='mat'?'MATERIALS':liqTab==='tool'?'TOOLS':liqTab==='allow'?'ALLOWANCE':liqTab==='cons'?'CONSUMABLES':liqTab==='misc'?'MISCELLANEOUS':'SUMMARY') : '')) : 'PERSONNEL DATA')}
    <div class="wrap">
      ${area === 'vessels' && html`<${Vessels} voyages=${voyages} sites=${sites} onReload=${loadVoyages} toast=${flash} />`}
      ${area === 'expenses' && html`<${Expenses} voyages=${voyages} toast=${flash} />`}
      ${area === 'liquidation' && html`<${Liquidation} voyages=${voyages} employees=${employees} sites=${sites} toast=${flash} tab=${liqTab} setTab=${setLiqTab} />`}
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
