// ============================================================
//  home.js — RSR Engineering admin dashboard (the start page)
//  PIN-gated. Shows live summaries; links into each module.
// ============================================================
import { html, render } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import { supabase } from './supabase.js';

const SESSION_KEY = 'rsr_admin';
const onAdminPage = location.pathname.includes('/admin');  // admin lives on its own page
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
async function getRepairLog() {
  const { data, error } = await supabase.from('repair_log')
    .select('id, transmittal_no, defect, transmitted_by, status, received_back_by, sent_at, repaired_at, repair_eta, items(name), item_units(unit_code)')
    .order('sent_at', { ascending: false }).limit(500);
  if (error) throw error;
  return data || [];
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
async function getIssued() {
  const { data, error } = await supabase.from('issuances')
    .select('id, proj_name, proj_code, emp_name, date, by_name, items, created_at')
    .order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  return data || [];
}
async function getVoyagesMon() {
  const { data, error } = await supabase.from('voyages')
    .select('*, sites(name)').order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  return data || [];
}
// attendance dates are stored in PH format (MM/DD/YYYY) by the kiosk
const MAT_CATALOG = ['Electrode handle','Welding gloves','Cutting tip','Dark glass','Clear glass','Trouble light','Electrical tape','Chalk stone','Dry chalk','Flint stone','Striker','Y-connector','Cutting disk','Oxygen regulator','LPG regulator','Steel square'];
async function getMatUsage() {
  const { data, error } = await supabase.from('material_usage').select('item_name,usage_days');
  if (error) throw error;
  return data || [];
}
async function upsertMatUsage(rows) {
  const { error } = await supabase.from('material_usage').upsert(rows, { onConflict: 'item_name' });
  if (error) throw error;
}
function todayPH() { return new Date().toLocaleDateString('en-PH', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
function todayYmd() { const d = new Date(), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }
function ymdToPH(ymd) { if (!ymd) return todayPH(); const [y, m, d] = ymd.split('-'); return `${m}/${d}/${y}`; }
async function getAttendance(dateStr) {
  const { data, error } = await supabase.from('attendance_records').select('*').eq('date', dateStr).order('employee_name');
  if (error) throw error;
  return data || [];
}
async function getLeaves() {
  const { data, error } = await supabase.from('leave_requests').select('*').order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  return data || [];
}
// Approve/reject a leave from Admin. On approval, deduct VL/SL balance (mirrors kiosk).
async function decideLeave(row, status) {
  await supabase.from('leave_requests')
    .update({ status, approved_by: 'Admin', approved_via: 'Admin app' }).eq('id', row.id);
  if (status === 'Approved' && row.employee_code && row.days) {
    const t = row.type;
    const col = t === 'Vacation Leave' ? 'vl_balance' : t === 'Sick Leave' ? 'sl_balance' : null;
    if (col) {
      const { data: emp } = await supabase.from('employees').select('id,' + col).eq('code', row.employee_code).maybeSingle();
      if (emp) {
        const newBal = Math.max(0, (Number(emp[col]) || 0) - Number(row.days));
        await supabase.from('employees').update({ [col]: newBal }).eq('id', emp.id);
      }
    }
  }
}
async function getApprovals() {
  const { data, error } = await supabase.from('pending_approvals').select('*').order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  return data || [];
}
async function getLiqRequests() {
  const { data, error } = await supabase.from('purchase_request').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  return data || [];
}
async function decideLiqRequest(id, status) {
  const { error } = await supabase.from('purchase_request').update({ status, approved_by: 'Admin', approved_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}
async function getStraightDuty() {
  const { data, error } = await supabase.from('straight_duty').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return data || [];
}
async function decideStraightDuty(id, status) {
  const { error } = await supabase.from('straight_duty').update({ status, decided_by: 'Admin', decided_on: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}
async function getLateBreaks() {
  const { data, error } = await supabase.from('late_break_requests').select('*').order('created_at', { ascending: false }).limit(60);
  if (error) throw error;
  return data || [];
}
async function decideLateBreakAdmin(id, status) {
  const { error } = await supabase.from('late_break_requests').update({ status, decided_by: 'Admin', decided_on: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}
async function getViolations() {
  const { data, error } = await supabase.from('violations').select('*').order('count', { ascending: false }).limit(200);
  if (error) throw error;
  return data || [];
}
async function getSmsLog() {
  const { data, error } = await supabase.from('sms_log').select('*').order('created_at', { ascending: false }).limit(100);
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
  const showNum = num !== undefined;
  const inner = html`
    <div class="ico">${ico}</div>
    ${showNum ? html`<div class=${'num' + (num == null ? ' dim' : '')}>${num == null ? '—' : num}</div>` : ''}
    <h3 style=${showNum ? '' : 'margin-top:8px'}>${title}</h3>
    ${unit ? html`<div class="unit">${unit}</div>` : ''}`;
  if (onClick) return html`<div class="tile" style="cursor:pointer" onClick=${onClick}>${inner}</div>`;
  return href
    ? html`<a class="tile" href=${href}>${inner}</a>`
    : html`<div class="tile soon">${ico ? html`<div class="ico">${ico}</div>` : ''}<h3 style="margin-top:8px">${title}</h3><span class="badge">COMING SOON</span></div>`;
}

function MatUsage({ toast, onBack }) {
  const [map, setMap] = useState({});
  const [extra, setExtra] = useState([]);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    getMatUsage().then(rows => {
      const mm = {}, ex = [];
      rows.forEach(r => { mm[r.item_name] = String(r.usage_days ?? ''); if (!MAT_CATALOG.includes(r.item_name)) ex.push(r.item_name); });
      setMap(mm); setExtra(ex);
    }).catch(() => {});
  }, []);
  const names = [...MAT_CATALOG, ...extra];
  const setDays = (n, v) => setMap(p => ({ ...p, [n]: v.replace(/[^0-9]/g, '') }));
  const addCustom = () => { const n = newName.trim(); if (!n) return; if (names.includes(n)) { toast('Already listed'); return; } setExtra(e => [...e, n]); setNewName(''); };
  const save = async () => {
    const rows = names.filter(n => map[n] !== undefined && map[n] !== '').map(n => ({ item_name: n, usage_days: parseInt(map[n], 10), updated_at: new Date().toISOString() }));
    if (!rows.length) { toast('Set at least one value'); return; }
    setSaving(true);
    try { await upsertMatUsage(rows); toast('Saved usage life'); } catch (e) { toast('Error: ' + e.message); } finally { setSaving(false); }
  };
  return html`
    <header class="app"><div class="wrap"><div class="brand" style="justify-content:space-between;display:flex;align-items:center">
      <span><b>RSR</b><span class="tag">MATERIAL USAGE</span></span>
      <button onClick=${onBack} style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">← Back</button>
    </div></div></header>
    <div class="wrap">
      <div class="card">
        <label>Usage life per material (days)</label>
        <p class="note" style="margin:2px 0 12px">Set here by admin only and re-adjustable. This is the expected service life used to flag when an issued material is due for replacement.</p>
        ${names.map(n => html`
          <div class="row" key=${n} style="align-items:center">
            <div class="name">${n}</div>
            <div style="display:flex;align-items:center;gap:6px">
              <input type="number" min="0" inputmode="numeric" value=${map[n] ?? ''} onInput=${e => setDays(n, e.target.value)} style="width:84px;text-align:right" placeholder="days" />
              <span class="unit">days</span>
            </div>
          </div>`)}
        <div class="row" style="align-items:center;border-top:1px solid var(--line);margin-top:6px;padding-top:10px">
          <input value=${newName} onInput=${e => setNewName(e.target.value)} placeholder="Add other material…" style="flex:1" />
          <button class="btn" style="width:auto;padding:10px 14px" onClick=${addCustom}>+ Add</button>
        </div>
        <button class="btn" disabled=${saving} onClick=${save} style="margin-top:12px">${saving ? 'Saving…' : 'Save usage life'}</button>
      </div>
    </div>`;
}

function RepairHistory() {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => { getRepairLog().then(setRows).catch(() => setRows([])); }, []);
  const dt = (s) => s ? new Date(s).toLocaleDateString() : '—';
  const repaired = (rows || []).filter(r => r.status === 'repaired');
  const ql = q.trim().toLowerCase();
  const list = ql ? repaired.filter(r => (((r.items && r.items.name) || '').toLowerCase().includes(ql)) || (((r.item_units && r.item_units.unit_code) || '').toLowerCase().includes(ql))) : repaired;
  return html`
    <div class="card">
      <div onClick=${() => setOpen(o => !o)} style="display:flex;align-items:center;justify-content:space-between;cursor:pointer">
        <label style="margin:0;cursor:pointer">Repair history${rows ? ` (${repaired.length})` : ''}</label>
        <span style="color:var(--ink-dim);font-weight:700;font-size:13px">${open ? '▲ Hide' : '▼ View'}</span>
      </div>
      ${open && html`
        <input placeholder="Search tool name or code (e.g. GR001)" value=${q} onInput=${e => setQ(e.target.value)} style="width:100%;margin-top:12px" />
        ${ql ? html`<div class="unit" style="margin:10px 0 2px;font-weight:700;color:var(--ink)">${list.length} repair${list.length === 1 ? '' : 's'} found${list.length ? ` for "${q}"` : ''}</div>` : ''}
        ${rows == null ? html`<div class="empty">Loading…</div>`
          : list.length ? list.map(r => html`
            <div class="row" key=${r.id} style="align-items:flex-start">
              <div>
                <div class="name">${r.items ? r.items.name : '—'} <span class="mono" style="color:var(--ink-dim);font-weight:400">· ${r.item_units ? r.item_units.unit_code : ''}</span></div>
                <div class="unit">${r.transmittal_no ? r.transmittal_no + ' · ' : ''}${r.defect || '—'}</div>
                <div class="unit">Sent by ${r.transmitted_by || '—'} · ${dt(r.sent_at)}</div>
                <div class="unit">Repaired ${dt(r.repaired_at)}${r.received_back_by ? ' · recv by ' + r.received_back_by : ''}</div>
              </div>
              <span class="badge" style="background:#12B89E;color:#000">REPAIRED</span>
            </div>`)
          : html`<div class="empty">${ql ? 'No repairs found for that tool.' : 'No repair history yet.'}</div>`}
      `}
    </div>`;
}

const MAT_TH = {'Electrode handle':3,'Welding gloves':3,'Cutting tip':5,'Dark glass':3,'Clear glass':3,'Trouble light':2,'Electrical tape':5,'Chalk stone':5,'Dry chalk':5,'Flint stone':5,'Striker':3,'Y-connector':2,'Cutting disk':5,'Oxygen regulator':1,'LPG regulator':1,'Steel square':1};
function muUnit(n){return ({'Welding gloves':'pair','Oxygen regulator':'unit','LPG regulator':'unit'})[n]||'pcs';}
const peso = (v) => '\u20b1' + (Number(v)||0).toLocaleString('en-PH',{maximumFractionDigits:2});

function Warehouse({ onBack }) {
  const [tab, setTab] = useState('requests');
  const [reqs, setReqs] = useState(null);
  const [stock, setStock] = useState({});
  const [prices, setPrices] = useState({});
  const [edit, setEdit] = useState({});
  const [purch, setPurch] = useState(null);
  const [rep, setRep] = useState(null);
  const [msg, setMsg] = useState(null);
  const [slip, setSlip] = useState(null);
  // purchase form
  const [pSup, setPSup] = useState('');
  const [pInv, setPInv] = useState('');
  const [pDate, setPDate] = useState(new Date().toISOString().slice(0,10));
  const [pBy, setPBy] = useState('');
  const [pRows, setPRows] = useState([{ n:'', qty:1, price:0 }]);
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(null), 2400); };

  const loadCore = async () => {
    try { const { data:rq } = await supabase.from('requests').select('*').in('status',['Pending','Approved','Dispatched']).order('created_at',{ascending:false}).limit(100); setReqs(rq||[]); } catch(e){ setReqs([]); }
    try { const { data:ws } = await supabase.from('warehouse_stock').select('item_name,qty'); const m={}; (ws||[]).forEach(r=>m[r.item_name]=Number(r.qty)||0); setStock(m); const ed={}; MAT_CATALOG.forEach(n=>ed[n]=String(m[n]??0)); setEdit(ed); } catch(e){}
    try { const { data:pr } = await supabase.from('item_prices').select('item_name,price'); const m={}; (pr||[]).forEach(r=>m[r.item_name]=Number(r.price)||0); setPrices(m); } catch(e){}
  };
  useEffect(() => { loadCore(); }, []);

  const itemsTxt = (r) => (Array.isArray(r.items)?r.items:[]).map(it=>(it.n||it.name)+' \u00d7'+it.qty).join(', ')||'\u2014';
  const badge = (s) => { const c={Pending:'#e8a330',Approved:'#378ADD',Dispatched:'#378ADD',Received:'#12B89E',Cancelled:'#9A9890'}[s]||'#9A9890'; return html`<span class="badge" style="background:${c};color:#fff">${(s||'').toUpperCase()}</span>`; };

  // ---- dispatch ----
  const dispatch = async (r) => {
    try {
      let drNo=''; try { const { data, error } = await supabase.rpc('next_dispatch_no'); if(!error&&data) drNo=data; } catch(e){}
      if(!drNo){ const n=new Date(),z=x=>String(x).padStart(2,'0'); drNo='DR-'+n.getFullYear()+z(n.getMonth()+1)+z(n.getDate())+'-'+z(n.getHours())+z(n.getMinutes())+z(n.getSeconds()); }
      for (const it of (r.items||[])) { const nm=it.n||it.name; const cur=stock[nm]||0; const nq=Math.max(0,cur-(it.qty||0)); await supabase.from('warehouse_stock').upsert({item_name:nm,qty:nq,updated_at:new Date().toISOString()},{onConflict:'item_name'}); }
      await supabase.from('requests').update({ status:'Dispatched', dr_no:drNo, updated_at:new Date().toISOString() }).eq('id', r.id);
      setSlip({ drNo, site:r.site, date:new Date().toISOString().slice(0,10), items:(r.items||[]).map(it=>({ n:it.n||it.name, u:it.u||muUnit(it.n||it.name), qty:it.qty })) });
      loadCore();
    } catch (e) { flash('Failed: ' + e.message); }
  };
  const cancel = async (r) => { try { await supabase.from('requests').update({status:'Cancelled',updated_at:new Date().toISOString()}).eq('id',r.id); flash('Cancelled'); loadCore(); } catch(e){ flash('Failed: '+e.message); } };

  // ---- stock ----
  const saveStock = async (name) => { const v=parseInt(edit[name],10); if(isNaN(v)||v<0){flash('Enter a valid qty');return;} try{ await supabase.from('warehouse_stock').upsert({item_name:name,qty:v,updated_at:new Date().toISOString()},{onConflict:'item_name'}); flash(name+' set to '+v); loadCore(); }catch(e){ flash('Failed: '+e.message); } };

  // ---- purchasing ----
  const pTotal = pRows.reduce((s,r)=>s+((parseFloat(r.qty)||0)*(parseFloat(r.price)||0)),0);
  const setRow = (i,k,v) => setPRows(rows => rows.map((r,j)=>j===i?{...r,[k]:v}:r));
  const addPRow = () => setPRows(rows => [...rows,{n:'',qty:1,price:0}]);
  const rmPRow = (i) => setPRows(rows => rows.filter((_,j)=>j!==i));
  const pickPItem = (i,name) => setPRows(rows => rows.map((r,j)=>j===i?{...r,n:name,price:(prices[name]||r.price||0)}:r));
  const savePurchase = async () => {
    if(!pSup.trim()){flash('Enter supplier');return;}
    const items=pRows.filter(r=>r.n&&parseInt(r.qty)>0).map(r=>({n:r.n,u:muUnit(r.n),qty:parseInt(r.qty),price:parseFloat(r.price)||0}));
    if(!items.length){flash('Add at least one item');return;}
    const n=new Date(),z=x=>String(x).padStart(2,'0');
    const id='PO-'+n.getFullYear()+z(n.getMonth()+1)+z(n.getDate())+'-'+z(n.getHours())+z(n.getMinutes())+z(n.getSeconds());
    const total=items.reduce((s,it)=>s+it.qty*it.price,0);
    try {
      await supabase.from('purchases').insert([{ id, supplier:pSup.trim(), invoice:pInv.trim()||null, date:pDate, received_by:pBy.trim()||null, items, grand_total:total, created_at:new Date().toISOString() }]);
      for (const it of items) { const cur=stock[it.n]||0; await supabase.from('warehouse_stock').upsert({item_name:it.n,qty:cur+it.qty,updated_at:new Date().toISOString()},{onConflict:'item_name'}); if(it.price>0) await supabase.from('item_prices').upsert({item_name:it.n,price:it.price,updated_at:new Date().toISOString()},{onConflict:'item_name'}); }
      flash('Purchase saved \u00b7 stock updated');
      setPSup(''); setPInv(''); setPBy(''); setPRows([{n:'',qty:1,price:0}]);
      await loadCore(); loadPurch();
    } catch (e) { flash('Failed: '+e.message); }
  };
  const loadPurch = async () => { try { const { data } = await supabase.from('purchases').select('*').order('created_at',{ascending:false}).limit(60); setPurch(data||[]); } catch(e){ setPurch([]); } };

  // ---- reports ----
  const loadReports = async () => {
    let iss=[];
    try { const since=new Date(Date.now()-30*864e5).toISOString(); const { data } = await supabase.from('issuances').select('proj_name,items,created_at').gte('created_at',since).limit(1000); iss=data||[]; } catch(e){}
    const consume={}, byVessel={}; let issuedTotal=0;
    iss.forEach(r=>{ (r.items||[]).forEach(it=>{ const nm=it.n||it.name, q=it.qty||0, pr=prices[nm]||0; consume[nm]=(consume[nm]||0)+q; issuedTotal+=q; const v=r.proj_name||'\u2014'; byVessel[v]=(byVessel[v]||0)+q*pr; }); });
    let stockValue=0; MAT_CATALOG.forEach(n=>{ stockValue+=(stock[n]||0)*(prices[n]||0); });
    setRep({ consume, byVessel, issuedTotal, stockValue });
  };

  useEffect(() => { if(tab==='buy'&&purch==null) loadPurch(); if(tab==='reports') loadReports(); }, [tab, stock, prices]);

  const lowItems = MAT_CATALOG.filter(n => (stock[n]||0) <= (MAT_TH[n]||0));

  const seg = (k,label) => html`<button onClick=${()=>setTab(k)} style="flex:1;padding:9px;border:none;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;background:${tab===k?'var(--ink-dim)':'transparent'};color:${tab===k?'#fff':'var(--ink-dim)'}">${label}</button>`;

  return html`
    <header class="app"><div class="wrap"><div class="brand" style="justify-content:space-between;display:flex;align-items:center">
      <span><b>RSR</b><span class="tag">WAREHOUSE</span></span>
      <button onClick=${onBack} style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">\u2190 Dashboard</button>
    </div></div></header>
    <div class="wrap">
      <div style="display:flex;gap:6px;background:var(--card,#fff);border:1px solid var(--line);border-radius:12px;padding:5px;margin-bottom:12px">
        ${seg('requests','Requests')}${seg('stock','Stock')}${seg('buy','Buy')}${seg('reports','Reports')}
      </div>

      ${tab==='requests' ? html`
        <div class="card">
          <label>Material requests${reqs?` (${reqs.length})`:''}</label>
          ${reqs==null ? html`<div class="empty">Loading\u2026</div>`
            : reqs.length ? reqs.map(r=>html`
              <div class="row" key=${r.id} style="align-items:flex-start">
                <div>
                  <div class="name">${r.site||'\u2014'} ${r.urgent?html`<span style="color:#d64045;font-weight:800;font-size:11px">\u00b7 URGENT</span>`:''}</div>
                  <div class="unit mono" style="color:var(--ink-dim)">${r.id}${r.dr_no?' \u00b7 '+r.dr_no:''}</div>
                  <div class="unit">${itemsTxt(r)}</div>
                  <div class="unit">${r.date||''}${r.by_name?' \u00b7 by '+r.by_name:''}</div>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
                  ${badge(r.status)}
                  ${r.status!=='Dispatched'?html`<button onClick=${()=>dispatch(r)} style="background:#12B89E;color:#000;border:none;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:800;cursor:pointer">Dispatch</button>`:''}
                  <button onClick=${()=>cancel(r)} style="background:none;border:1px solid var(--line);color:var(--ink-dim);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer">Cancel</button>
                </div>
              </div>`)
            : html`<div class="empty">No open requests.</div>`}
        </div>` : ''}

      ${tab==='stock' ? html`
        ${lowItems.length?html`<div class="card" style="border-color:#e8a330;background:#FAEEDA">
          <label style="color:#7a4a06">\u26a0 Low / reorder (${lowItems.length})</label>
          <div class="unit" style="color:#7a4a06">${lowItems.map(n=>`${n} (${stock[n]||0})`).join(' \u00b7 ')}</div>
        </div>`:''}
        <div class="card">
          <label>Warehouse stock (your place)</label>
          ${MAT_CATALOG.map(n=>{ const low=(stock[n]||0)<=(MAT_TH[n]||0); return html`
            <div class="row" key=${n}>
              <div><div class="name" style=${low?'color:#d64045':''}>${n}</div><div class="unit">${muUnit(n)} \u00b7 min ${MAT_TH[n]||0}${prices[n]?' \u00b7 '+peso(prices[n]):''}</div></div>
              <div style="display:flex;gap:6px;align-items:center">
                <input type="number" min="0" value=${edit[n]??''} onInput=${e=>setEdit({...edit,[n]:e.target.value})} style="width:70px;text-align:center;padding:8px;border:1px solid var(--line);border-radius:8px;font-size:15px"/>
                <button onClick=${()=>saveStock(n)} style="background:var(--ink-dim);color:#fff;border:none;border-radius:8px;padding:8px 12px;font-size:13px;font-weight:700;cursor:pointer">Set</button>
              </div>
            </div>`;})}
        </div>` : ''}

      ${tab==='buy' ? html`
        <div class="card">
          <label>New purchase</label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0">
            <input placeholder="Supplier *" value=${pSup} onInput=${e=>setPSup(e.target.value)} style="padding:10px;border:1px solid var(--line);border-radius:8px"/>
            <input placeholder="Invoice / PO no" value=${pInv} onInput=${e=>setPInv(e.target.value)} style="padding:10px;border:1px solid var(--line);border-radius:8px"/>
            <input type="date" value=${pDate} onInput=${e=>setPDate(e.target.value)} style="padding:10px;border:1px solid var(--line);border-radius:8px"/>
            <input placeholder="Received by" value=${pBy} onInput=${e=>setPBy(e.target.value)} style="padding:10px;border:1px solid var(--line);border-radius:8px"/>
          </div>
          ${pRows.map((r,i)=>html`
            <div key=${i} style="display:grid;grid-template-columns:minmax(0,1fr) 56px 78px 28px;gap:6px;align-items:center;margin-bottom:6px">
              <select value=${r.n} onChange=${e=>pickPItem(i,e.target.value)} style="padding:9px;border:1px solid var(--line);border-radius:8px">
                <option value="">\u2014 Item \u2014</option>${MAT_CATALOG.map(n=>html`<option value=${n} selected=${r.n===n}>${n}</option>`)}
              </select>
              <input type="number" min="1" value=${r.qty} onInput=${e=>setRow(i,'qty',e.target.value)} style="padding:9px;border:1px solid var(--line);border-radius:8px;text-align:center"/>
              <input type="number" min="0" step="0.01" placeholder="\u20b1" value=${r.price} onInput=${e=>setRow(i,'price',e.target.value)} style="padding:9px;border:1px solid var(--line);border-radius:8px;text-align:center"/>
              <button onClick=${()=>rmPRow(i)} style="background:none;border:1px solid var(--line);border-radius:8px;padding:8px 0;color:var(--ink-dim);cursor:pointer">\u00d7</button>
            </div>`)}
          <button onClick=${addPRow} style="width:100%;padding:10px;border:1px dashed var(--ink-dim);background:none;color:var(--ink-dim);border-radius:8px;font-weight:700;cursor:pointer;margin-top:2px">+ Add item</button>
          <div class="row" style="margin-top:10px"><div class="name">Grand total</div><div class="name" style="color:#12B89E">${peso(pTotal)}</div></div>
          <button onClick=${savePurchase} style="width:100%;padding:13px;background:var(--ink-dim);color:#fff;border:none;border-radius:10px;font-weight:800;cursor:pointer;margin-top:8px">Save purchase \u00b7 add to stock</button>
        </div>
        <div class="card">
          <label>Purchase history${purch?` (${purch.length})`:''}</label>
          ${purch==null?html`<div class="empty">Loading\u2026</div>`
            : purch.length?purch.map(p=>html`
              <div class="row" key=${p.id} style="align-items:flex-start">
                <div><div class="name">${p.supplier||'\u2014'} ${p.invoice?html`<span class="unit">\u00b7 ${p.invoice}</span>`:''}</div>
                <div class="unit">${(p.items||[]).map(it=>(it.n||it.name)+' \u00d7'+it.qty).join(', ')}</div>
                <div class="unit">${p.date||''}${p.received_by?' \u00b7 '+p.received_by:''}</div></div>
                <div class="name" style="color:#12B89E;white-space:nowrap">${peso(p.grand_total)}</div>
              </div>`)
            : html`<div class="empty">No purchases yet.</div>`}
        </div>` : ''}

      ${tab==='reports' ? html`
        ${rep==null?html`<div class="card"><div class="empty">Loading\u2026</div></div>`:html`
        <div class="card"><label>Stock on hand value</label><div class="name" style="font-size:24px;color:#12B89E">${peso(rep.stockValue)}</div><div class="unit">Across ${MAT_CATALOG.length} materials at current prices</div></div>
        <div class="card"><label>Consumption (last 30 days) \u00b7 ${rep.issuedTotal} issued</label>
          ${Object.keys(rep.consume).length?Object.entries(rep.consume).sort((a,b)=>b[1]-a[1]).map(([n,q])=>html`<div class="row" key=${n}><div class="name">${n}</div><div class="unit">${q} ${muUnit(n)}</div></div>`):html`<div class="empty">No issuances in 30 days.</div>`}
        </div>
        <div class="card"><label>Cost per vessel (last 30 days)</label>
          ${Object.keys(rep.byVessel).length?Object.entries(rep.byVessel).sort((a,b)=>b[1]-a[1]).map(([v,c])=>html`<div class="row" key=${v}><div class="name">${v}</div><div class="name" style="color:#12B89E">${peso(c)}</div></div>`):html`<div class="empty">No data yet.</div>`}
          <div class="unit" style="margin-top:8px">Based on issued quantities \u00d7 last purchase price.</div>
        </div>`}` : ''}

      <p class="note" style="text-align:center">You control the warehouse. Dispatch reduces stock; purchases add stock.</p>
    </div>

    ${slip && html`<div style="position:fixed;inset:0;background:rgba(15,25,15,.5);z-index:80;display:flex;align-items:center;justify-content:center;padding:16px" onClick=${()=>setSlip(null)}>
      <div class="card" style="max-width:360px;width:100%;margin:0" onClick=${e=>e.stopPropagation()}>
        <div style="text-align:center;border-bottom:1.5px dashed var(--line);padding-bottom:12px;margin-bottom:12px">
          <div style="font-weight:800">RSR \u2014 Dispatch Receipt</div>
          <div class="mono" style="color:#378ADD;font-size:14px">${slip.drNo}</div>
          <div class="unit">${slip.date} \u00b7 to ${slip.site}</div>
        </div>
        ${slip.items.map(it=>html`<div class="row" key=${it.n}><div class="name">${it.n}</div><div class="unit">${it.qty} ${it.u}</div></div>`)}
        <button onClick=${()=>setSlip(null)} style="width:100%;padding:12px;background:var(--ink-dim);color:#fff;border:none;border-radius:10px;font-weight:800;cursor:pointer;margin-top:10px">Done</button>
      </div></div>`}
    ${msg && html`<div class="toast">${msg}</div>`}`;
}

function App() {
  const [adminTab, setAdminTab] = useState('dash');  // 'dash' | 'people'
  const [authed, setAuthed] = useState(false);   // always require the passcode on open
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
  const [sitePin, setSitePin] = useState('');
  const [rate, setRate] = useState('');          // current/starting daily rate
  const [incRate, setIncRate] = useState('');     // new rate for an increase
  const [incDate, setIncDate] = useState('');
  const [incNote, setIncNote] = useState('');
  const [salHist, setSalHist] = useState([]);
  const [bor, setBor] = useState(null);     // borrowed-now list
  const [rep, setRep] = useState(null);     // repair units
  const [inv, setInv] = useState(null);     // { units, outs }
  const [iss, setIss] = useState(null);     // issued materials list
  const [attPresent, setAttPresent] = useState({}); // {name|date: true} for issuance-date attendance
  const [ves, setVes] = useState(null);     // vessels monitor list
  const [att, setAtt] = useState(null);     // today's attendance summary
  const [attRows, setAttRows] = useState(null);  // per-employee rows for the monitor
  const [attYmd, setAttYmd] = useState(todayYmd());
  const [hrRows, setHrRows] = useState(null);   // generic rows for HR monitor tabs
  const [liqReqs, setLiqReqs] = useState(null);   // coordinator purchase requests to approve
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
  const saveSitePin = async () => {
    if (!sitePin.trim()) { flash('Enter a passcode'); return; }
    try { await setSetting('issuance_pin', sitePin.trim()); setSitePin(''); flash('Issuance passcode set'); }
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
    if (!authed || !onAdminPage) return;
    const iso30 = new Date(Date.now() - 30 * 864e5).toISOString();
    (async () => {
      const [toolsOut, inRepair, issued30, vessels, people, pendingReqs, poInbox] = await Promise.all([
        countRows('borrow_issuance', q => q.eq('txn_type', 'borrow').eq('status', 'out')),
        countRows('item_units', q => q.eq('active', true).eq('status', 'repair')),
        countRows('issuances', q => q.gte('created_at', iso30)),
        countRows('voyages', q => q.neq('status', 'not_active')),
        countRows('employees', q => q),
        countRows('requests', q => q.eq('status', 'Pending')),
        countRows('requisitions', q => q.eq('status', 'for_purchase')),
      ]);
      setM({ toolsOut, inRepair, issued30, vessels, people, pendingReqs, poInbox });
      try {
        const recs = await getAttendance(todayPH());
        const c = (f) => recs.filter(f).length;
        const present = c(r => r.status !== 'absent');
        setAtt({ working: c(r => r.status === 'working'), onBreak: c(r => r.status === 'break'),
                 out: c(r => r.status === 'out'), late: c(r => r.is_late),
                 total: people || 0, absent: Math.max(0, (people || 0) - present) });
      } catch (_) { setAtt(null); }
    })();
  }, [authed]);

  useEffect(() => {
    if (!(authed && onAdminPage && adminTab === 'attendance')) return;
    (async () => { try { setAttRows(await getAttendance(ymdToPH(attYmd))); } catch (e) { flash('Load failed: ' + e.message); } })();
  }, [adminTab, attYmd, authed]);

  useEffect(() => {
    const loaders = { leaves: getLeaves, approvals: getApprovals, duty: getStraightDuty, latebreaks: getLateBreaks, violations: getViolations, sms: getSmsLog };
    if (!(authed && onAdminPage && loaders[adminTab])) return;
    setHrRows(null);
    (async () => { try { setHrRows(await loaders[adminTab]()); } catch (e) { flash('Load failed: ' + e.message); } })();
  }, [adminTab, authed]);

  useEffect(() => { if (authed && onAdminPage) loadEmps(); }, [authed]);
  useEffect(() => { if (authed && showSet) loadEmps(); }, [authed, showSet]);

  useEffect(() => {
    if (!(authed && onAdminPage)) return;
    if (adminTab === 'borrowed') (async () => {
      try { setBor(await getBorrowedNow()); setInv(await getInventory()); }
      catch (e) { flash('Load failed: ' + e.message); }
    })();
    if (adminTab === 'repair') (async () => {
      try { setRep(await getRepairUnits()); }
      catch (e) { flash('Load failed: ' + e.message); }
    })();
    if (adminTab === 'issued') (async () => {
      try {
        const rows = await getIssued();
        setIss(rows);
        // cross-check: pull attendance for the issuance dates to flag issued-but-absent
        const dates = [...new Set(rows.map(r => r.date).filter(Boolean))];
        if (dates.length) {
          const { data } = await supabase.from('attendance_records')
            .select('employee_name, date, status').in('date', dates).limit(5000);
          const present = {};
          (data || []).forEach(a => { present[(a.employee_name || '').trim().toLowerCase() + '|' + a.date] = true; });
          setAttPresent(present);
        } else setAttPresent({});
      }
      catch (e) { flash('Load failed: ' + e.message); }
    })();
    if (adminTab === 'vessels') (async () => {
      try { setVes(await getVoyagesMon()); }
      catch (e) { flash('Load failed: ' + e.message); }
    })();
  }, [adminTab, authed]);

  // floating back button (bottom-right) on every admin sub-screen
  useEffect(() => {
    let fab = document.getElementById('admin-back-fab');
    const cleanup = () => { const f = document.getElementById('admin-back-fab'); if (f) f.remove(); };
    if (!(authed && onAdminPage) || adminTab === 'dash') { cleanup(); return; }
    const hrTabs = ['leaves','approvals','duty','latebreaks','violations','sms','people','salary'];
    const toolTabs = ['borrowed','repair'];
    const target = hrTabs.includes(adminTab) ? 'hrmenu' : (toolTabs.includes(adminTab) ? 'toolsmenu' : 'dash');
    if (!fab) {
      fab = document.createElement('button');
      fab.id = 'admin-back-fab';
      fab.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;background:var(--hivis,#E8A830);color:#000;border:none;border-radius:24px;padding:13px 20px;font-size:14px;font-weight:800;box-shadow:0 4px 16px rgba(0,0,0,.4);cursor:pointer';
      document.body.appendChild(fab);
    }
    fab.textContent = (target === 'dash') ? '← Dashboard' : '← Back';
    fab.onclick = () => setAdminTab(target);
    return cleanup;
  }, [adminTab, authed, onAdminPage]);

  // auto-logout the admin after 2 minutes of no activity
  useEffect(() => {
    if (!(authed && onAdminPage)) return;
    let t;
    const logout = () => { sessionStorage.removeItem(SESSION_KEY); setAuthed(false); setShowSet(false); setAdminTab('dash'); };
    const reset = () => { clearTimeout(t); t = setTimeout(logout, 2 * 60 * 1000); };
    const evs = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
    evs.forEach(e => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => { clearTimeout(t); evs.forEach(e => window.removeEventListener(e, reset)); };
  }, [authed]);

  // ---- front chooser (everyone except admin): Coordinator | Issuance ----
  if (!onAdminPage) return html`
    <header class="app">
      <div class="wrap"><div class="brand"><b>RSR</b><span class="tag">ENGINEERING</span></div></div>
    </header>
    <div class="wrap">
      <div class="sectlabel">Choose your area</div>
      <div class="grid">
        <a class="tile" href="./coordinator/">
          <div class="ico">🗂️</div>
          <h3>Coordinator</h3>
          <div class="unit">Personnel & vessel schedules</div>
        </a>
        <a class="tile" href="./issuance/">
          <div class="ico">📦</div>
          <h3>Issuance</h3>
          <div class="unit">Tool inventory & material issuance</div>
        </a>
      </div>
      <p class="note" style="text-align:center;margin-top:6px">RSR Engineering Services · Cebu</p>
    </div>
    ${toast && html`<div class="toast">${toast}</div>`}`;

  // ---- admin login (its own page, always asks) ----
  if (!authed) return html`<${Lock} onUnlock=${() => setAuthed(true)} toast=${flash} />
    ${toast && html`<div class="toast">${toast}</div>`}`;

  const live = [
    { ico:'🔧', num:(m.toolsOut||0)+(m.inRepair||0), unit:'out + repair', title:'Tools', onClick:() => setAdminTab('toolsmenu') },
    { ico:'📦', num:m.issued30,  unit:'issued (30 days)', title:'Material Issuance', onClick:() => setAdminTab('issued') },
    { ico:'🏠', num:m.pendingReqs, unit:'pending requests', title:'Warehouse',        href:'../warehouse/' },
    { ico:'🛒', num:m.poInbox,    unit:'to purchase',      title:'Purchasing',        href:'../purchasing/' },
    { ico:'💵', num:null,         unit:'weekly',           title:'Payroll',           href:'../payroll/' },
    { ico:'🚢', num:m.vessels,   unit:'active',          title:'Vessel Schedule',  onClick:() => setAdminTab('vessels') },
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
        <button onClick=${() => setAdminTab('toolsmenu')} style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">← Tools</button>
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

  // ---- admin: vessel schedule monitor (read-only) ----
  if (adminTab === 'vessels') {
    const stLabel = { drydock:'Drydock', afloat:'Afloat', not_active:'Not active' };
    const stColor = { drydock:'var(--hivis)', afloat:'#12B89E', not_active:'#888' };
    return html`
      <header class="app"><div class="wrap"><div class="brand" style="justify-content:space-between;display:flex;align-items:center">
        <span><b>RSR</b><span class="tag">VESSELS</span></span>
        <button onClick=${() => setAdminTab('dash')} style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">← Dashboard</button>
      </div></div></header>
      <div class="wrap">
        <div class="card">
          <label>Vessels${ves ? ` (${ves.length})` : ''}</label>
          ${ves == null ? html`<div class="empty">Loading…</div>`
            : ves.length ? ves.map(v => html`
              <div class="row" key=${v.id} style="align-items:flex-start">
                <div>
                  <div class="name">${v.vessel_name || '—'} ${v.vessel_code ? html`<span class="mono" style="color:var(--ink-dim);font-weight:400">· ${v.vessel_code}</span>` : ''}</div>
                  <div class="unit">${(v.sites && v.sites.name) || '—'}${v.start_date ? ' · ' + v.start_date : ''}${v.end_date ? ' → ' + v.end_date : ''}</div>
                  ${v.notes ? html`<div class="unit">${v.notes}</div>` : ''}
                </div>
                <span class="badge" style=${'background:' + (stColor[v.status] || '#888') + ';color:#000'}>${stLabel[v.status] || v.status || '—'}</span>
              </div>`)
            : html`<div class="empty">No vessels yet. Your assistant adds them in the Coordinator.</div>`}
        </div>
        <p class="note" style="text-align:center">View only.</p>
      </div>
      ${toast && html`<div class="toast">${toast}</div>`}`;
  }

  // ---- admin: material issuance monitor (read-only) ----
  if (adminTab === 'matusage') return html`<${MatUsage} toast=${flash} onBack=${() => setAdminTab('issued')} />`;
  if (adminTab === 'warehouse') return html`<${Warehouse} onBack=${() => setAdminTab('dash')} />`;

  // ---- admin: approve coordinator material / tool requests ----
  if (adminTab === 'issued') {
    const dt = (s) => s ? new Date(s).toLocaleDateString() : '—';
    const wasPresent = (r) => attPresent[(r.emp_name || '').trim().toLowerCase() + '|' + r.date];
    const absentList = (iss || []).filter(r => r.emp_name && r.date && !wasPresent(r));
    return html`
      <header class="app"><div class="wrap"><div class="brand" style="justify-content:space-between;display:flex;align-items:center">
        <span><b>RSR</b><span class="tag">MATERIAL ISSUANCE</span></span>
        <button onClick=${() => setAdminTab('dash')} style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">← Dashboard</button>
      </div></div></header>
      <div class="wrap">
        ${iss && absentList.length ? html`
        <div class="card" style="border-color:var(--hivis)">
          <div style="font-weight:800;color:var(--hivis)">⚠ ${absentList.length} issued to someone ABSENT that day</div>
          <p class="note" style="margin:4px 0 0">Material was issued to a person with no attendance record on the issuance date — check if the material is actually being used.</p>
        </div>` : ''}
        <div class="card">
          <label>Issued materials${iss ? ` (${iss.length})` : ''}</label>
          ${iss == null ? html`<div class="empty">Loading…</div>`
            : iss.length ? iss.map(r => {
              const absent = r.emp_name && r.date && !wasPresent(r);
              return html`
              <div class="row" key=${r.id} style="align-items:flex-start">
                <div>
                  <div class="name">${r.emp_name || '—'}</div>
                  <div class="unit">${r.proj_name || '—'}${r.proj_code ? ' (' + r.proj_code + ')' : ''} · ${r.date || ''}${r.by_name ? ' · by ' + r.by_name : ''}</div>
                  <div class="unit">${(Array.isArray(r.items) ? r.items : []).map(it => (it.name || it.n) + ' ×' + it.qty).join(', ') || '—'}</div>
                </div>
                ${absent
                  ? html`<span class="badge" style="background:#D64045;color:#fff">ABSENT THAT DAY</span>`
                  : html`<span class="badge" style="background:#12B89E;color:#000">PRESENT</span>`}
              </div>`;
            })
            : html`<div class="empty">No materials issued yet.</div>`}
        </div>
        <div class="card" style="cursor:pointer" onClick=${() => setAdminTab('matusage')}>
          <div class="brand" style="display:flex;align-items:center;justify-content:space-between">
            <span><div class="name">⏳ Usage life (days)</div><div class="unit">Set how long each material should last</div></span>
            <span style="color:var(--ink-dim);font-weight:700">→</span>
          </div>
        </div>
        <p class="note" style="text-align:center">"Absent that day" = material issued to a person with no attendance record on the issuance date.</p>
      </div>
      ${toast && html`<div class="toast">${toast}</div>`}`;
  }

  // ---- admin: tool repair monitor ----
  if (adminTab === 'repair') {
    return html`
      <header class="app"><div class="wrap"><div class="brand" style="justify-content:space-between;display:flex;align-items:center">
        <span><b>RSR</b><span class="tag">TOOL REPAIR</span></span>
        <button onClick=${() => setAdminTab('toolsmenu')} style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">← Tools</button>
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
        <${RepairHistory} />
        <p class="note" style="text-align:center">View only.</p>
      </div>
      ${toast && html`<div class="toast">${toast}</div>`}`;
  }

  // ---- admin: HR monitors (read-only) ----
  const hrTitles = { leaves:'LEAVES', approvals:'APPROVALS', duty:'STRAIGHT DUTY', latebreaks:'LATE BREAKS', violations:'VIOLATIONS', sms:'SMS LOG' };
  if (hrTitles[adminTab]) {
    const statusPill = (s) => {
      const k = (s || '').toLowerCase();
      const c = k === 'approved' ? '#12B89E' : k === 'rejected' || k === 'denied' ? '#D64045' : k === 'pending' ? 'var(--hivis)' : '#888';
      return html`<span class="badge" style=${'background:' + c + ';color:#000'}>${s || '—'}</span>`;
    };
    const apprLabels = {
      late_lunch_out:'Late Lunch Out', late_pm_out:'Late PM Break Out', late_timein:'Late Time In',
      late_timeout:'Late Time Out', incomplete:'Incomplete Record', early_break_lunch_out:'Early Lunch Out',
      early_break_pm_out:'Early PM Break Out', straight_duty_lunch:'Straight Duty — Lunch', straight_duty_pm:'Straight Duty — PM',
    };
    const body = (() => {
      if (hrRows == null) return html`<div class="empty">Loading…</div>`;
      if (!hrRows.length) return html`<div class="empty">Nothing here yet.</div>`;
      if (adminTab === 'leaves') return hrRows.map(r => {
        const decide = async (st) => { try { await decideLeave(r, st); flash(r.employee_name + ' ' + st.toLowerCase()); setHrRows(await getLeaves()); } catch (e) { flash('Error: ' + e.message); } };
        return html`
        <div class="row" key=${r.id} style="align-items:flex-start">
          <div>
            <div class="name">${r.employee_name} <span class="mono" style="color:var(--ink-dim);font-weight:400">· ${r.type || '—'}</span></div>
            <div class="unit">${r.start_date || '?'} → ${r.end_date || '?'}${r.days ? ' · ' + r.days + ' day(s)' : ''}</div>
            ${r.reason ? html`<div class="unit">${r.reason}</div>` : ''}
            ${r.status !== 'Pending' && r.approved_by ? html`<div class="unit" style="color:var(--ink-dim)">${r.status} by ${r.approved_by}${r.approved_via ? ' (' + r.approved_via + ')' : ''}</div>` : ''}
            ${r.status === 'Pending' ? html`<div style="display:flex;gap:8px;margin-top:8px">
              <button class="btn" style="padding:6px 14px;font-size:13px" onClick=${() => decide('Approved')}>✅ Approve</button>
              <button class="btn ghost" style="padding:6px 14px;font-size:13px" onClick=${() => decide('Rejected')}>❌ Reject</button>
            </div>` : ''}
          </div>
          ${statusPill(r.status)}
        </div>`;
      });
      if (adminTab === 'approvals') return hrRows.map(r => html`
        <div class="row" key=${r.id} style="align-items:flex-start">
          <div>
            <div class="name">${r.employee_name || '—'} <span class="mono" style="color:var(--ink-dim);font-weight:400">${r.employee_dept ? '· ' + r.employee_dept : ''}</span></div>
            <div class="unit">${apprLabels[r.type] || r.type || '—'}</div>
            ${r.details ? html`<div class="unit">${r.details}</div>` : ''}
            <div class="unit">${r.punch_time || ''}${r.date ? ' · ' + r.date : ''}</div>
          </div>
          ${statusPill(r.status)}
        </div>`);
      if (adminTab === 'duty') return hrRows.map(r => {
        const decide = async (st) => { try { await decideStraightDuty(r.id, st); flash(r.employee_name + ' ' + st.toLowerCase()); setHrRows(await getStraightDuty()); } catch (e) { flash('Error: ' + e.message); } };
        return html`
        <div class="row" key=${r.id} style="align-items:flex-start">
          <div>
            <div class="name">${r.employee_name}</div>
            <div class="unit">${r.break_type === 'lunch' ? '🍽️' : '☕'} ${r.break_label || ''}${r.date ? ' · ' + r.date : ''}</div>
            ${r.reason ? html`<div class="unit">${r.reason}</div>` : ''}
            ${r.status !== 'Pending' && r.decided_by ? html`<div class="unit" style="color:var(--ink-dim)">${r.status} by ${r.decided_by}</div>` : ''}
            ${r.status === 'Pending' ? html`<div style="display:flex;gap:8px;margin-top:8px">
              <button class="btn" style="padding:6px 14px;font-size:13px" onClick=${() => decide('Approved')}>✅ Approve</button>
              <button class="btn ghost" style="padding:6px 14px;font-size:13px" onClick=${() => decide('Rejected')}>❌ Reject</button>
            </div>` : ''}
          </div>
          ${statusPill(r.status)}
        </div>`;
      });
      if (adminTab === 'latebreaks') return hrRows.map(r => {
        const decide = async (st) => { try { await decideLateBreakAdmin(r.id, st); flash(r.employee_name + ' ' + st.toLowerCase()); setHrRows(await getLateBreaks()); } catch (e) { flash('Error: ' + e.message); } };
        const lbl = r.break_type === 'pm_out' ? 'PM Break (late)' : 'Lunch (late)';
        return html`
        <div class="row" key=${r.id} style="align-items:flex-start">
          <div>
            <div class="name">${r.employee_name || r.employee_code}</div>
            <div class="unit">⏰ ${lbl}${r.date ? ' · ' + r.date : ''}${r.punch_time ? ' · ' + r.punch_time : ''}</div>
            ${r.status !== 'Pending' && r.decided_by ? html`<div class="unit" style="color:var(--ink-dim)">${r.status} by ${r.decided_by}</div>` : ''}
            ${r.status === 'Pending' ? html`<div style="display:flex;gap:8px;margin-top:8px">
              <button class="btn" style="padding:6px 14px;font-size:13px" onClick=${() => decide('Approved')}>✅ Approve</button>
              <button class="btn ghost" style="padding:6px 14px;font-size:13px" onClick=${() => decide('Rejected')}>❌ Reject</button>
            </div>` : ''}
          </div>
          ${statusPill(r.status)}
        </div>`;
      });
      if (adminTab === 'violations') return hrRows.map(r => {
        const hist = Array.isArray(r.history) ? r.history.slice(0, 3) : [];
        return html`<div class="row" key=${r.id || r.employee_name} style="align-items:flex-start">
          <div>
            <div class="name">${r.employee_name}</div>
            ${hist.map(h => html`<div class="unit">#${h.violation}: ${h.date}</div>`)}
          </div>
          <span class="badge" style=${'background:' + (r.count >= 3 ? '#D64045' : r.count === 2 ? 'var(--hivis)' : '#888') + ';color:#000'}>🚨 ${r.count}</span>
        </div>`;
      });
      if (adminTab === 'sms') return hrRows.map(r => html`
        <div class="row" key=${r.id} style="align-items:flex-start">
          <div>
            <div class="name">${r.employee_name} <span class="mono" style="color:var(--ink-dim);font-weight:400">· ${r.phone || ''}</span></div>
            <div class="unit">${r.date || ''}${r.day ? ' · Day ' + r.day + ' of 3' : ''}${r.network ? ' · ' + r.network : ''}</div>
            ${r.message ? html`<div class="unit">${String(r.message).slice(0, 90)}</div>` : ''}
          </div>
          <span class="badge">${String(r.status || '').includes('✅') ? 'SENT' : (r.status || '—')}</span>
        </div>`);
    })();
    return html`
      <header class="app"><div class="wrap"><div class="brand" style="justify-content:space-between;display:flex;align-items:center">
        <span><b>RSR</b><span class="tag">${hrTitles[adminTab]}</span></span>
        <button onClick=${() => setAdminTab('hrmenu')} style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">← HR Monitors</button>
      </div></div></header>
      <div class="wrap">
        <div class="card">
          <label>${hrTitles[adminTab][0] + hrTitles[adminTab].slice(1).toLowerCase()}${hrRows ? ` (${hrRows.length})` : ''}</label>
          ${body}
        </div>
        ${adminTab === 'duty' || adminTab === 'latebreaks' || adminTab === 'leaves' ? '' : html`<p class="note" style="text-align:center">View only.${adminTab === 'approvals' ? ' Approvals are actioned via Telegram.' : ''}</p>`}
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

  // ---- admin: Tools sub-menu ----
  if (adminTab === 'toolsmenu') {
    return html`
      <header class="app"><div class="wrap"><div class="brand" style="justify-content:space-between;display:flex;align-items:center">
        <span><b>RSR</b><span class="tag">TOOLS</span></span>
        <button onClick=${() => setAdminTab('dash')} style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">← Dashboard</button>
      </div></div></header>
      <div class="wrap">
        <div class="grid">
          ${[
            { ico:'🔧', title:'Tool Borrowing', unit:'out now', onClick:() => setAdminTab('borrowed') },
            { ico:'🛠️', title:'Tool Repair',   unit:'in repair', onClick:() => setAdminTab('repair') },
          ].map(t => html`<${Tile} ...${t} />`)}
        </div>
      </div>
      ${toast && html`<div class="toast">${toast}</div>`}`;
  }

  // ---- admin: HR Monitors sub-menu ----
  if (adminTab === 'hrmenu') {
    return html`
      <header class="app"><div class="wrap"><div class="brand" style="justify-content:space-between;display:flex;align-items:center">
        <span><b>RSR</b><span class="tag">HR MONITORS</span></span>
        <button onClick=${() => setAdminTab('hrmenu')} style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">← HR Monitors</button>
      </div></div></header>
      <div class="wrap">
        <div class="grid">
          ${[
            { ico:'🌴', title:'Leaves',        onClick:() => setAdminTab('leaves') },
            { ico:'⚠️', title:'Approvals',     onClick:() => setAdminTab('approvals') },
            { ico:'⚡', title:'Straight Duty', onClick:() => setAdminTab('duty') },
            { ico:'⏰', title:'Late Breaks',   onClick:() => setAdminTab('latebreaks') },
            { ico:'👷', title:'Personnel',     onClick:() => setAdminTab('people') },
            { ico:'💰', title:'Salary',        onClick:() => setAdminTab('salary') },
            { ico:'🚨', title:'Violations',    onClick:() => setAdminTab('violations') },
            { ico:'📱', title:'SMS Log',       onClick:() => setAdminTab('sms') },
          ].map(t => html`<${Tile} ...${t} />`)}
        </div>
      </div>
      ${toast && html`<div class="toast">${toast}</div>`}`;
  }

  // ---- admin: salary (dedicated, simple) ----
  if (adminTab === 'salary') {
    const sel = emps.find(x => x.id === empSel);
    return html`
      <header class="app"><div class="wrap"><div class="brand" style="justify-content:space-between;display:flex;align-items:center">
        <span><b>RSR</b><span class="tag">SALARY</span></span>
        <button onClick=${() => { setEmpSel(''); setAdminTab('hrmenu'); }} style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">← HR Monitors</button>
      </div></div></header>
      <div class="wrap">
        ${!empSel ? html`
        <div class="card">
          <label>Personnel (${emps.length}) — tap to set rate</label>
          ${emps.length ? [...emps].sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(e => html`
            <div class="row" key=${e.id} style="cursor:pointer" onClick=${() => pickEmp(e.id)}>
              <div>
                <div class="name">${e.name} <span class="mono" style="color:var(--ink-dim);font-weight:400">· ${e.code || '—'}</span></div>
                <div class="unit">${e.position || 'No position'}</div>
              </div>
              <span class="badge" style=${e.daily_rate ? 'background:#12B89E;color:#000' : 'background:var(--hivis);color:#000'}>${e.daily_rate ? '₱' + Number(e.daily_rate).toLocaleString('en-PH') + '/day' : 'no rate'}</span>
            </div>`) : html`<div class="empty">No personnel yet.</div>`}
        </div>` : html`
        <div class="card">
          <button onClick=${() => setEmpSel('')} style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer;padding:0;margin-bottom:10px">← All personnel</button>
          <div class="name" style="font-size:17px">${sel ? sel.name : ''} <span class="mono" style="color:var(--ink-dim);font-weight:400">· ${sel ? (sel.code||'—') : ''}</span></div>
          <div class="unit" style="margin-bottom:14px">Current rate: <b style="color:var(--ink)">${sel && sel.daily_rate ? '₱' + Number(sel.daily_rate).toLocaleString('en-PH') + '/day' : 'not set'}</b></div>

          <${Field} label="Set daily rate ₱">
            <input type="number" min="0" value=${rate} onInput=${e => setRate(e.target.value)} placeholder="0" />
          <//>
          <button class="btn" onClick=${saveRate}>Save daily rate</button>

          <div style="border-top:1px solid var(--line);margin:18px 0 12px"></div>
          <div class="sectlabel" style="margin-top:0">Record a salary increase</div>
          <p class="note" style="margin:0 0 10px">Use this when the rate goes up, so it's dated and kept in history.</p>
          <div class="grid" style="margin-bottom:0">
            <${Field} label="New daily rate ₱"><input type="number" min="0" value=${incRate} onInput=${e => setIncRate(e.target.value)} placeholder="0" /><//>
            <${Field} label="Effective date"><input type="date" value=${incDate} onInput=${e => setIncDate(e.target.value)} /><//>
          </div>
          <${Field} label="Note (optional)"><input value=${incNote} onInput=${e => setIncNote(e.target.value)} placeholder="e.g. annual increase" /><//>
          <button class="btn" onClick=${addIncrease}>Add increase</button>

          ${salHist.length > 0 ? html`
            <div style="margin-top:18px">
              <div class="sectlabel">Salary history</div>
              ${salHist.map(h => html`
                <div class="row" key=${h.id}>
                  <div>
                    <div class="name">₱${Number(h.daily_rate).toLocaleString('en-PH')}/day</div>
                    <div class="unit">${h.effective_date ? 'Effective ' + h.effective_date : 'No date'}${h.note ? ' · ' + h.note : ''}</div>
                  </div>
                </div>`)}
            </div>` : html`<div class="note" style="margin-top:14px">No increases recorded yet.</div>`}
        </div>`}
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
                <div class="unit">Passcode: <span class="mono" style="font-weight:700;letter-spacing:1px">${e.pin || '— not set —'}</span></div>
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
          <button onClick=${() => { sessionStorage.removeItem(SESSION_KEY); setAuthed(false); setShowSet(false); setAdminTab('dash'); }}
            style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">lock</button>
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
          <div class="sectlabel" style="margin-top:0">Issuance (site) passcode</div>
          <p class="note" style="margin:0 0 12px">The passcode site personnel use to open the borrow/issue app.</p>
          <${Field} label="Set / change issuance passcode">
            <input type="password" inputmode="numeric" value=${sitePin} onInput=${e => setSitePin(e.target.value)} placeholder="e.g. 7777" />
          <//>
          <button class="btn" onClick=${saveSitePin}>Save issuance passcode</button>
        </div>

        <div class="card">
          <div class="sectlabel" style="margin-top:0">Employee passcode & leave</div>
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

      <div class="sectlabel">HR monitors</div>
      <div class="grid">
        ${[
          { ico:'🧑‍💼', title:'HR Monitors', unit:'leaves, salary, etc.', onClick:() => setAdminTab('hrmenu') },
        ].map(t => html`<${Tile} ...${t} />`)}
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
