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
    .select('id, name, position, pin, contact, active').order('name').limit(2000);
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

// ---------- small ui ----------
function Field({ label, children }) {
  return html`<div class="field"><label>${label}</label>${children}</div>`;
}

// ---------- PIN gate ----------
function Lock({ onUnlock, toast }) {
  const [pin, setPin] = useState('');
  const tryUnlock = () => {
    const admin = localStorage.getItem('rsr_admin_pin') || '1234';
    if (pin === admin) { sessionStorage.setItem('rsr_admin', '1'); onUnlock(); }
    else toast('Wrong PIN', true);
  };
  return html`
    <div class="card lock">
      <div class="brand" style="justify-content:center;margin-bottom:14px"><b>RSR</b><span class="tag">COORDINATOR</span></div>
      <${Field} label="Enter coordinator PIN">
        <input type="password" inputmode="numeric" value=${pin}
          onInput=${e => setPin(e.target.value)} placeholder="default 1234" />
      <//>
      <button class="btn" onClick=${tryUnlock}>Unlock</button>
    </div>`;
}

// ---------- Personnel ----------
function Personnel({ employees, onReload, toast }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [position, setPosition] = useState('');
  const [contact, setContact] = useState('');
  const [pin, setPin] = useState('');
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);

  const reset = () => { setCode(''); setName(''); setPosition(''); setContact(''); setPin(''); setEditId(null); };

  const submit = async () => {
    if (!name.trim()) { toast('Enter a name', true); return; }
    setSaving(true);
    try {
      if (editId) {
        await updateEmployee(editId, { name: name.trim(), position: position.trim() || null, contact: contact.trim() || null, pin: pin || null });
        toast('Employee updated');
      } else {
        if (!code.trim()) { toast('Enter an employee code', true); setSaving(false); return; }
        await addEmployee({ id: code.trim(), name: name.trim(), position: position.trim() || null, contact: contact.trim() || null, pin: pin || null });
        toast('Employee added');
      }
      reset(); onReload();
    } catch (e) { toast('Error: ' + e.message, true); }
    finally { setSaving(false); }
  };

  const edit = (e) => { setEditId(e.id); setCode(e.id); setName(e.name || ''); setPosition(e.position || ''); setContact(e.contact || ''); setPin(e.pin || ''); };

  return html`
    <div class="card">
      <${Field} label="Employee code">
        <input value=${code} disabled=${!!editId} onInput=${e => setCode(e.target.value)} placeholder="e.g. EMP-001" />
      <//>
      <${Field} label="Full name">
        <input value=${name} onInput=${e => setName(e.target.value)} placeholder="e.g. Juan Dela Cruz" />
      <//>
      <div class="two">
        <${Field} label="Position">
          <input value=${position} onInput=${e => setPosition(e.target.value)} placeholder="e.g. Fitter" />
        <//>
        <${Field} label="Passcode (PIN)">
          <input value=${pin} onInput=${e => setPin(e.target.value)} placeholder="e.g. 1234" />
        <//>
      </div>
      <${Field} label="Contact number">
        <input type="tel" inputmode="tel" value=${contact} onInput=${e => setContact(e.target.value)} placeholder="e.g. 0917 123 4567" />
      <//>
      <button class="btn" disabled=${saving} onClick=${submit}>${saving ? 'Saving…' : (editId ? 'Update Employee' : 'Add Employee')}</button>
      ${editId && html`<button class="btn ghost" style="margin-top:8px" onClick=${reset}>Cancel edit</button>`}
    </div>

    <div class="card">
      <label>Personnel (${employees.length})</label>
      ${employees.length ? employees.map(e => html`
        <div class="row" key=${e.id}>
          <div>
            <div class="name">${e.name} <span class="mono" style="color:var(--ink-dim);font-weight:400">· ${e.id}</span></div>
            <div class="sub">${e.position || '—'}${e.contact ? ' · ' + e.contact : ''}${e.pin ? ' · PIN set' : ' · no PIN'}</div>
          </div>
          <button class="ret" onClick=${() => edit(e)}>Edit</button>
        </div>`) : html`<div class="empty">No personnel yet.</div>`}
    </div>`;
}

// ---------- Vessel schedule ----------
const STATUS = [['drydock','Drydock'], ['afloat','Afloat repair'], ['not_active','Not active']];
function Vessels({ voyages, sites, onReload, toast }) {
  const [vessel, setVessel] = useState('');
  const [siteId, setSiteId] = useState('');
  const [status, setStatus] = useState('drydock');
  const [docking, setDocking] = useState('');
  const [undocking, setUndocking] = useState('');
  const [departure, setDeparture] = useState('');
  const [afloatStart, setAfloatStart] = useState('');
  const [afloatDone, setAfloatDone] = useState('');
  const [notes, setNotes] = useState('');
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);

  const reset = () => { setVessel(''); setSiteId(''); setStatus('drydock'); setDocking(''); setUndocking('');
    setDeparture(''); setAfloatStart(''); setAfloatDone(''); setNotes(''); setEditId(null); };

  const submit = async () => {
    if (!vessel.trim()) { toast('Enter a vessel name', true); return; }
    setSaving(true);
    const row = {
      vessel_name: vessel.trim(), site_id: siteId || null, status,
      docking_date: docking || null, undocking_date: undocking || null, departure_date: departure || null,
      afloat_start: afloatStart || null, afloat_done: afloatDone || null, notes: notes || null,
    };
    try {
      if (editId) { await updateVoyage(editId, row); toast('Schedule updated'); }
      else { await addVoyage(row); toast('Vessel scheduled'); }
      reset(); onReload();
    } catch (e) { toast('Error: ' + e.message, true); }
    finally { setSaving(false); }
  };

  const edit = (v) => {
    setEditId(v.id); setVessel(v.vessel_name); setSiteId(v.site_id || ''); setStatus(v.status || 'drydock');
    setDocking(v.docking_date || ''); setUndocking(v.undocking_date || ''); setDeparture(v.departure_date || '');
    setAfloatStart(v.afloat_start || ''); setAfloatDone(v.afloat_done || ''); setNotes(v.notes || '');
  };
  const remove = async (v) => {
    if (!confirm(`Delete schedule for "${v.vessel_name}"?`)) return;
    try { await deleteVoyage(v.id); toast('Deleted'); onReload(); }
    catch (e) { toast('Error: ' + e.message, true); }
  };

  const isDry = status === 'drydock';
  const isAfloat = status === 'afloat';

  return html`
    <div class="card">
      <${Field} label="Vessel name">
        <input value=${vessel} onInput=${e => setVessel(e.target.value)} placeholder="e.g. MV SF Trinity" />
      <//>
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
          <${Field} label="Repair start"><input type="date" value=${afloatStart} onInput=${e => setAfloatStart(e.target.value)} /><//>
          <${Field} label="Repair done"><input type="date" value=${afloatDone} onInput=${e => setAfloatDone(e.target.value)} /><//>
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
            <div class="name">${v.vessel_name} <span class="pill">${(STATUS.find(s=>s[0]===v.status)||['','?'])[1]}</span></div>
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
function App() {
  const [authed, setAuthed] = useState(sessionStorage.getItem('rsr_admin') === '1');
  const [tab, setTab] = useState('personnel');
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
      <div class="card lock">
        <div class="brand" style="justify-content:center;margin-bottom:6px"><b>RSR</b><span class="tag">COORDINATOR</span></div>
        <p class="note" style="margin:0 0 14px">Open this from the Admin dashboard to unlock.</p>
        <a class="btn" href="../" style="display:block;text-align:center;text-decoration:none">Go to Admin</a>
      </div>
    </div>`;

  return html`
    <header class="app">
      <div class="wrap"><div class="brand" style="display:flex;align-items:center;justify-content:space-between">
        <span><b>RSR</b><span class="tag">COORDINATOR</span></span>
        <a href="../" style="color:var(--ink-dim);text-decoration:none;font-size:13px;font-weight:700">⌂ Home</a>
      </div></div>
    </header>
    <div class="wrap">
      ${fatal && html`<div class="card" style="border-color:var(--warn)"><div class="note" style="color:#ffc7c0">Couldn't reach Supabase: ${fatal}. Check supabase.js key and that you ran the SQL.</div></div>`}

      <div class="tabs">
        <button class=${tab==='personnel'?'on':''} onClick=${() => setTab('personnel')}>Personnel</button>
        <button class=${tab==='vessels'?'on':''}  onClick=${() => setTab('vessels')}>Vessels</button>
      </div>

      ${tab==='personnel' && html`<${Personnel} employees=${employees} onReload=${loadEmployees} toast=${flash} />`}
      ${tab==='vessels' && html`<${Vessels} voyages=${voyages} sites=${sites} onReload=${loadVoyages} toast=${flash} />`}
    </div>
    ${toast && html`<div class=${'toast' + (toast.err?' err':'')}>${toast.msg}</div>`}
  `;
}

render(html`<${App} />`, document.getElementById('app'));
