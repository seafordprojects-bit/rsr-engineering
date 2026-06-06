// ============================================================
//  app.js  —  Borrow & Issuance module (Preact + htm, no build)
//  Shows the component pattern: small reusable pieces (Picker,
//  Field) composed into screens. This is the structure the whole
//  suite reuses — login, tables, pickers written once.
// ============================================================
import { html, render } from 'htm/preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import {
  supabase,
  getSites, getEmployees,
  createTransaction,
} from './supabase.js';

// Local items query (adds replacement price) so supabase.js stays untouched.
async function getItems() {
  const { data, error } = await supabase
    .from('items')
    .select('id, item_code, name, unit, track_type, price')
    .eq('active', true)
    .order('name')
    .limit(2000);
  if (error) throw error;
  return data;
}
async function updateItemPrice(id, price) {
  const v = (price === '' || price == null) ? null : Number(price);
  const { error } = await supabase.from('items').update({ price: v }).eq('id', id);
  if (error) throw error;
}

// Local return (records who received it; server stamps the time).
async function returnItem(txnId, condition, receivedBy) {
  const { error } = await supabase.rpc('mark_returned', {
    txn_id: txnId, cond: condition || null, received: receivedBy || null,
  });
  if (error) throw error;
}

// Local copy of open-borrows (adds employee_id + unit so Return can verify and show the code).
async function getOpenBorrows(siteId) {
  let q = supabase
    .from('borrow_issuance')
    .select('id, quantity, borrowed_at, project_vessel, issued_by, employee_id, unit_id, ' +
            'items(item_code, name, unit), employees(name), item_units(unit_code)')
    .eq('txn_type', 'borrow')
    .eq('status', 'out')
    .order('borrowed_at', { ascending: false })
    .limit(100);
  if (siteId) q = q.eq('site_id', siteId);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}
// individual tool units (Grinder -> GR-001, GR-002) for a location
async function getUnits(siteId) {
  let q = supabase.from('item_units')
    .select('id, unit_code, item_id, status, defect, repair_eta')
    .eq('active', true)
    .order('unit_code')
    .limit(3000);
  if (siteId) q = q.eq('site_id', siteId);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}
async function sendToRepair(unitId, defect, eta) {
  const { error } = await supabase.from('item_units')
    .update({ status: 'repair', defect: defect || null, repair_eta: eta || null }).eq('id', unitId);
  if (error) throw error;
}
async function markRepaired(unitId) {
  const { error } = await supabase.from('item_units')
    .update({ status: 'available', defect: null, repair_eta: null }).eq('id', unitId);
  if (error) throw error;
}
// full history for the audit view (bounded)
async function getRecords(siteId) {
  let q = supabase.from('borrow_issuance')
    .select('id, txn_type, status, quantity, borrowed_at, returned_at, return_condition, issued_by, received_by, project_vessel, notes, employee_id, items(name, item_code), item_units(unit_code), employees(name)')
    .order('borrowed_at', { ascending: false })
    .limit(300);
  if (siteId) q = q.eq('site_id', siteId);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}
async function addUnit(fields) {
  const { error } = await supabase.from('item_units').insert(fields);
  if (error) throw error;
}
async function deactivateUnit(id) {
  const { error } = await supabase.from('item_units').update({ active: false }).eq('id', id);
  if (error) throw error;
}
async function deleteUnitsForItem(itemId) {     // frees the codes when a tool is removed
  const { error } = await supabase.from('item_units').delete().eq('item_id', itemId);
  if (error) throw error;
}
// insert several borrow/issue lines in one go (one slip)
async function createMany(rows) {
  const { error } = await supabase.from('borrow_issuance').insert(rows);
  if (error) throw error;
}
// insert several unit codes at once (auto-generated sequence)
async function addUnits(rows) {
  const { error } = await supabase.from('item_units').insert(rows);
  if (error) throw error;
}
const newId = () => (crypto?.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random()*16|0; return (c === 'x' ? r : (r&0x3|0x8)).toString(16); }));

const fmt = (ts) => ts ? new Date(ts).toLocaleString('en-PH',
  { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH');

// ---- stock data (kept here so supabase.js stays untouched) ----
async function getStock(siteId) {
  let q = supabase
    .from('site_inventory')
    .select('qty_owned, site_id, items(id, item_code, name, unit, track_type)')
    .limit(1000);                                  // bounded
  if (siteId) q = q.eq('site_id', siteId);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}
// how many of each item are currently OUT (for the available calc)
async function getOutCounts(siteId) {
  let q = supabase
    .from('borrow_issuance')
    .select('item_id, quantity')
    .eq('status', 'out')
    .limit(1000);
  if (siteId) q = q.eq('site_id', siteId);
  const { data, error } = await q;
  if (error) throw error;
  const map = {};
  (data || []).forEach(r => { map[r.item_id] = (map[r.item_id] || 0) + Number(r.quantity || 0); });
  return map;
}
async function setStock(itemId, siteId, qty) {
  const { error } = await supabase
    .from('site_inventory')
    .upsert({ item_id: itemId, site_id: siteId, qty_owned: Number(qty) || 0 },
            { onConflict: 'site_id,item_id' });
  if (error) throw error;
}
async function addItem(fields) {
  const { data, error } = await supabase.from('items').insert(fields).select().single();
  if (error) throw error;
  return data;
}
async function deactivateItem(id) {              // soft-delete: keeps borrow history intact
  const { error } = await supabase.from('items').update({ active: false }).eq('id', id);
  if (error) throw error;
}
// recent material issuances (consumed, no return) for the Issue section
async function getRecentIssuances(siteId) {
  let q = supabase
    .from('borrow_issuance')
    .select('id, quantity, borrowed_at, project_vessel, issued_by, items(name, unit), employees(name)')
    .eq('txn_type', 'issuance')
    .order('borrowed_at', { ascending: false })
    .limit(100);
  if (siteId) q = q.eq('site_id', siteId);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}
// verify an employee's passcode server-side (the PIN never leaves the database)
async function verifyPin(empId, pin) {
  const { data, error } = await supabase.rpc('verify_pin', { emp_id: empId, pin_input: pin });
  if (error) throw error;
  return data === true;
}

const ST_ROW = 'display:grid;grid-template-columns:1fr 58px 44px 58px;gap:8px;align-items:center;padding:11px 0;border-bottom:1px solid var(--line);';
const ST_NUM = 'text-align:right;font-family:"JetBrains Mono",monospace;font-weight:700;';
const LOC    = 'flex:1;padding:13px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--ink-dim);font-weight:800;letter-spacing:.5px;cursor:pointer;';
const LOC_ON = 'flex:1;padding:13px;border-radius:10px;border:1px solid var(--hivis);background:var(--hivis);color:var(--hivis-ink);font-weight:800;letter-spacing:.5px;cursor:pointer;';

// ---------- reusable bits ----------
function Field({ label, children }) {
  return html`<div class="field"><label>${label}</label>${children}</div>`;
}

function Picker({ label, value, onChange, options, placeholder }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const selLabel = (options.find(o => o.id === value) || {}).label || '';
  const q = query.trim().toLowerCase();
  const filtered = (open && q) ? options.filter(o => o.label.toLowerCase().includes(q)) : options;
  return html`
    <${Field} label=${label}>
      <div style="position:relative">
        <input
          value=${open ? query : selLabel}
          placeholder=${placeholder}
          autocomplete="off"
          onFocus=${() => { setOpen(true); setQuery(''); }}
          onInput=${e => { setQuery(e.target.value); setOpen(true); }}
          onBlur=${() => setTimeout(() => setOpen(false), 150)} />
        ${open && html`
          <div style="position:absolute;left:0;right:0;top:100%;margin-top:4px;z-index:30;background:var(--panel-2);border:1px solid var(--line);border-radius:10px;max-height:240px;overflow:auto;box-shadow:0 8px 30px rgba(0,0,0,.45)">
            ${filtered.length ? filtered.map(o => html`
              <div key=${o.id}
                onMouseDown=${() => { onChange(o.id); setQuery(''); setOpen(false); }}
                style="padding:12px;border-bottom:1px solid var(--line);cursor:pointer">${o.label}</div>`)
            : html`<div style="padding:12px;color:var(--ink-dim)">No match</div>`}
          </div>`}
      </div>
    <//>`;
}

// ---------- New borrow / issuance slip (multiple items) ----------
function NewTransaction({ mode, sites, employees, items, units, outUnitIds, defaultSite, onSaved, toast }) {
  const isBorrow = mode === 'borrow';
  const [employeeId, setEmployeeId] = useState('');
  const [siteId, setSiteId]   = useState(defaultSite || '');
  const [issuedBy, setIssuedBy] = useState('');
  const [project, setProject]   = useState('');
  const [notes, setNotes]       = useState('');
  const [pin, setPin]           = useState('');
  const [saving, setSaving]     = useState(false);
  // current line being added
  const [itemId, setItemId]     = useState('');
  const [unitId, setUnitId]     = useState('');
  const [qty, setQty]           = useState('1');
  // the slip's list of items
  const [cart, setCart]         = useState([]);

  useEffect(() => { setSiteId(defaultSite || ''); }, [defaultSite]);

  const itemOpts = items.filter(i => isBorrow ? i.track_type !== 'issue' : i.track_type === 'issue');
  const itemUnits = (units || []).filter(u => u.item_id === itemId);
  const hasUnits  = isBorrow && itemUnits.length > 0;
  // available = not out AND not already added to this slip
  const inCart = new Set(cart.map(c => c.unitId).filter(Boolean));
  const availableUnits = itemUnits.filter(u => u.status !== 'repair' && !outUnitIds.has(u.id) && !inCart.has(u.id));

  const pickItem = (v) => { setItemId(v); setUnitId(''); };

  const itemName = (id) => (items.find(i => i.id === id)?.name) || 'Item';
  const itemCode = (id) => (items.find(i => i.id === id)?.item_code) || '';
  const unitCode = (id) => (units.find(u => u.id === id)?.unit_code) || '';
  const priceOf  = (id) => Number(items.find(i => i.id === id)?.price || 0);
  const cartValue = cart.reduce((s, c) => s + priceOf(c.itemId) * c.qty, 0);

  const addLine = () => {
    if (!itemId) { toast('Pick an item first', true); return; }
    if (hasUnits && !unitId) { toast('Pick a unit code', true); return; }
    const codeTxt = unitId ? unitCode(unitId) : itemCode(itemId);
    setCart([...cart, {
      itemId, unitId: unitId || null,
      qty: hasUnits ? 1 : (Number(qty) || 1),
      label: itemName(itemId) + (codeTxt ? ' · ' + codeTxt : (Number(qty) > 1 ? ' ×' + qty : '')),
    }]);
    setItemId(''); setUnitId(''); setQty('1');
  };
  const removeLine = (idx) => setCart(cart.filter((_, i) => i !== idx));

  const reset = () => { setEmployeeId(''); setIssuedBy(''); setProject(''); setNotes(''); setPin('');
    setItemId(''); setUnitId(''); setQty('1'); setCart([]); };

  const submit = async () => {
    if (!employeeId) { toast('Pick a person', true); return; }
    if (!cart.length) { toast('Add at least one item', true); return; }
    if (!pin) { toast('Enter the passcode', true); return; }
    setSaving(true);
    try {
      const ok = await verifyPin(employeeId, pin);
      if (!ok) { toast('Wrong passcode (or none set for this person)', true); setSaving(false); return; }
      const batch_id = newId();   // links all items on this slip
      const rows = cart.map(c => ({
        txn_type: mode,
        employee_id: employeeId,
        item_id: c.itemId,
        unit_id: c.unitId,
        site_id: siteId || null,
        quantity: c.qty,
        status: isBorrow ? 'out' : 'issued',
        issued_by: issuedBy || null,
        project_vessel: project || null,
        notes: notes || null,
        batch_id,
      }));
      await createMany(rows);
      toast(`${isBorrow ? 'Borrowed' : 'Issued'} ${rows.length} item${rows.length>1?'s':''}`);
      reset();
      onSaved();
    } catch (e) {
      toast('Error: ' + e.message, true);
    } finally { setSaving(false); }
  };

  return html`
    <div class="card">
      <${Picker} label=${isBorrow ? 'Borrower' : 'Receiver'} value=${employeeId} onChange=${setEmployeeId}
        placeholder="Select employee…"
        options=${employees.map(e => ({ id:e.id, label:`${e.name}${e.id? ' · '+e.id:''}` }))} />

      <div style="border:1px dashed var(--line);border-radius:10px;padding:12px;margin-bottom:14px">
        <${Picker} label=${isBorrow ? 'Tool' : 'Material'} value=${itemId} onChange=${pickItem}
          placeholder=${isBorrow ? 'Select tool…' : 'Select material…'}
          options=${itemOpts.map(i => ({ id:i.id, label:`${i.name}${i.item_code? ' · '+i.item_code:''}` }))} />

        ${hasUnits && html`
          <${Picker} label="Unit code" value=${unitId} onChange=${setUnitId}
            placeholder=${availableUnits.length ? 'Select unit…' : 'No units available'}
            options=${availableUnits.map(u => ({ id:u.id, label:u.unit_code }))} />`}

        ${!hasUnits && html`
          <${Field} label="Quantity">
            <input type="number" min="1" value=${qty} onInput=${e => setQty(e.target.value)} />
          <//>`}

        <button class="btn ghost" onClick=${addLine}>+ Add to slip</button>
      </div>

      ${cart.length > 0 && html`
        <div class="card" style="margin:0 0 14px;background:var(--panel-2)">
          <label>Items on this slip (${cart.length})</label>
          ${cart.map((c, idx) => html`
            <div class="row" key=${idx}>
              <div>
                <div class="name">${c.label}</div>
                ${isBorrow && priceOf(c.itemId) ? html`<div class="sub">${peso(priceOf(c.itemId) * c.qty)}</div>` : ''}
              </div>
              <button class="ret" onClick=${() => removeLine(idx)}>✕</button>
            </div>`)}
          ${isBorrow && cartValue > 0 ? html`<div class="row" style="border-bottom:none">
            <div class="name">Total replacement value</div>
            <div class="name mono" style="color:var(--hivis)">${peso(cartValue)}</div>
          </div>` : ''}
        </div>`}

      <${Field} label=${isBorrow ? 'Released by' : 'Issued by'}>
        <input value=${issuedBy} onInput=${e => setIssuedBy(e.target.value)} placeholder="Warehouse staff name" />
      <//>

      <${Field} label="Project / Vessel">
        <input value=${project} onInput=${e => setProject(e.target.value)} placeholder="e.g. MV Seafarer drydock" />
      <//>

      <${Field} label="Notes">
        <textarea rows="2" value=${notes} onInput=${e => setNotes(e.target.value)}></textarea>
      <//>

      ${isBorrow && cart.length > 0 && html`
        <div style="background:rgba(255,176,0,.08);border:1px solid var(--hivis);border-radius:10px;padding:12px;margin-bottom:14px">
          <div style="font-weight:800;color:var(--hivis);letter-spacing:.4px;margin-bottom:6px">LIABILITY NOTICE</div>
          <div class="note" style="line-height:1.55">
            By signing with my passcode, I confirm that I:<br/>
            1. Received the listed tools in good working condition.<br/>
            2. Am responsible for their safekeeping while in my possession.<br/>
            3. Will be charged the replacement value shown for any lost or damaged item.<br/>
            4. Will return them promptly once the work is completed.
          </div>
        </div>`}

      <${Field} label=${isBorrow ? 'Borrower passcode (sign here)' : 'Receiver passcode (sign here)'}>
        <input type="password" inputmode="numeric" autocomplete="off"
          value=${pin} onInput=${e => setPin(e.target.value)} placeholder="Enter passcode to confirm" />
      <//>

      <button class="btn" disabled=${saving || !cart.length} onClick=${submit}>
        ${saving ? 'Saving…' : (isBorrow ? `Borrow Out (${cart.length})` : `Issue (${cart.length})`)}
      </button>
    </div>`;
}

// ---------- Active borrows, grouped by who holds them ----------
function ActiveBorrows({ rows, onReturn }) {
  if (!rows.length) return html`<div class="card"><div class="empty">No tools currently out.</div></div>`;
  const groups = {};
  rows.forEach(r => { const k = r.employees?.name || '—'; (groups[k] = groups[k] || []).push(r); });
  const code = (r) => r.item_units?.unit_code || r.items?.item_code || '';
  return html`
    ${Object.entries(groups).map(([name, list]) => html`
      <div class="card" key=${name}>
        <label>${name} — ${list.length} item${list.length>1?'s':''} out</label>
        ${list.map(r => html`
          <div class="row" key=${r.id}>
            <div>
              <div class="name">${r.items?.name || 'Item'} ${code(r) ? html`<span class="mono" style="color:var(--hivis)">· ${code(r)}</span>` : (r.quantity > 1 ? `×${r.quantity}` : '')}</div>
              <div class="sub">${r.project_vessel ? r.project_vessel + ' · ' : ''}<span class="mono">out ${fmt(r.borrowed_at)}</span></div>
            </div>
            <button class="ret" onClick=${() => onReturn(r)}>Return</button>
          </div>`)}
      </div>`)}
  `;
}

// ---------- In Store: tool counts derived automatically from registered codes ----------
function ToolStore({ items, units, outUnitIds, stockRows, outCounts }) {
  const qtyMap = {};
  (stockRows || []).forEach(r => { if (r.items) qtyMap[r.items.id] = (qtyMap[r.items.id] || 0) + Number(r.qty_owned || 0); });
  const list = (items || []).map(i => {
    const myUnits = (units || []).filter(u => u.item_id === i.id);
    let owned, out, repair = 0;
    if (myUnits.length) {                 // coded tool → owned = number of codes
      owned = myUnits.length;
      out = myUnits.filter(u => outUnitIds.has(u.id)).length;
      repair = myUnits.filter(u => u.status === 'repair').length;
    } else {                              // uncoded tool → manual qty fallback
      owned = qtyMap[i.id] || 0;
      out = outCounts[i.id] || 0;
    }
    return { id: i.id, name: i.name, owned, out, repair, avail: owned - out - repair };
  }).sort((a, b) => a.name.localeCompare(b.name));

  if (!list.length) return html`<div class="card"><div class="empty">No tools registered yet. Add them in Register Tools.</div></div>`;
  return html`
    <div class="card">
      <div style=${ST_ROW}>
        <span style="font-size:11px;font-weight:800;letter-spacing:.5px;color:var(--ink-dim)">TOOL</span>
        <span style=${ST_NUM + 'font-size:11px;color:var(--ink-dim)'}>OWNED</span>
        <span style=${ST_NUM + 'font-size:11px;color:var(--ink-dim)'}>OUT</span>
        <span style=${ST_NUM + 'font-size:11px;color:var(--ink-dim)'}>AVAIL</span>
      </div>
      ${list.map(r => html`
        <div style=${ST_ROW} key=${r.id}>
          <span class="name">${r.name}${r.repair > 0 ? html`<span class="sub" style="color:var(--warn)"> · ${r.repair} in repair</span>` : ''}</span>
          <span style=${ST_NUM}>${r.owned}</span>
          <span style=${ST_NUM + (r.out > 0 ? 'color:var(--hivis)' : 'color:var(--ink-dim)')}>${r.out}</span>
          <span style=${ST_NUM + (r.avail <= 0 ? 'color:var(--warn)' : '')}>${r.avail}</span>
        </div>`)}
    </div>`;
}

// ---------- For Repair: tag defective units, mark them repaired ----------
function ForRepair({ items, units, outUnitIds, onSendRepair, onRepaired, toast }) {
  const [itemId, setItemId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [defect, setDefect] = useState('');
  const [eta, setEta] = useState('');
  const [saving, setSaving] = useState(false);

  const itemName = (id) => (items.find(i => i.id === id)?.name) || 'Tool';
  const itemUnits = (units || []).filter(u => u.item_id === itemId);
  const available = itemUnits.filter(u => u.status !== 'repair' && !outUnitIds.has(u.id));
  const inRepair = (units || []).filter(u => u.status === 'repair');
  const pickItem = (v) => { setItemId(v); setUnitId(''); };

  const submit = async () => {
    if (!unitId) { toast('Pick a unit', true); return; }
    setSaving(true);
    try {
      await onSendRepair(unitId, defect, eta);
      toast('Sent to repair');
      setItemId(''); setUnitId(''); setDefect(''); setEta('');
    } catch (e) { toast('Error: ' + e.message, true); }
    finally { setSaving(false); }
  };

  return html`
    <div class="card">
      <${Picker} label="Tool" value=${itemId} onChange=${pickItem} placeholder="Select tool…"
        options=${items.map(i => ({ id:i.id, label:i.name }))} />
      ${itemId && html`
        <${Picker} label="Unit code" value=${unitId} onChange=${setUnitId}
          placeholder=${available.length ? 'Select unit…' : 'No available units'}
          options=${available.map(u => ({ id:u.id, label:u.unit_code }))} />`}
      <${Field} label="Defect description">
        <textarea rows="2" value=${defect} onInput=${e => setDefect(e.target.value)} placeholder="What's wrong with it?"></textarea>
      <//>
      <${Field} label="Expected ready (optional)">
        <input value=${eta} onInput=${e => setEta(e.target.value)} placeholder="e.g. next week" />
      <//>
      <button class="btn" disabled=${saving} onClick=${submit}>${saving ? 'Saving…' : 'Send to Repair'}</button>
    </div>

    <div class="card">
      <label>In repair (${inRepair.length})</label>
      ${inRepair.length ? inRepair.map(u => html`
        <div class="row" key=${u.id}>
          <div>
            <div class="name">${itemName(u.item_id)} · <span class="mono" style="color:var(--warn)">${u.unit_code}</span></div>
            <div class="sub">${u.defect || 'no note'}${u.repair_eta ? ' · ready ' + u.repair_eta : ''}</div>
          </div>
          <button class="ret" onClick=${() => onRepaired(u.id)}>Repaired</button>
        </div>`) : html`<div class="empty">Nothing in repair.</div>`}
    </div>`;
}

// ---------- All Records (audit history) ----------
const recCode = (r) => r.item_units?.unit_code || r.items?.item_code || '';
const recState = (r) => r.txn_type === 'issuance' ? 'issued' : (r.status === 'returned' ? 'returned' : 'out');

function Records({ rows, filter, setFilter, onOpen }) {
  const shown = rows.filter(r => {
    if (filter === 'out')      return r.txn_type === 'borrow' && r.status === 'out';
    if (filter === 'returned') return r.status === 'returned';
    if (filter === 'issued')   return r.txn_type === 'issuance';
    return true;
  });
  const FILTERS = [['all','All'], ['out','Out'], ['returned','Returned'], ['issued','Issued']];
  return html`
    <div class="tabs" style="flex-wrap:wrap">
      ${FILTERS.map(([f, lbl]) => html`
        <button key=${f} class=${filter===f?'on':''} onClick=${() => setFilter(f)}>${lbl}</button>`)}
    </div>
    <div class="card">
      ${shown.length ? shown.map(r => html`
        <div class="row" key=${r.id} onClick=${() => onOpen(r)} style="cursor:pointer">
          <div>
            <div class="name">${r.items?.name || 'Item'} ${recCode(r) ? html`<span class="mono" style="color:var(--hivis)">· ${recCode(r)}</span>` : ''}</div>
            <div class="sub">${r.employees?.name || r.employee_id} · ${fmt(r.borrowed_at)}</div>
          </div>
          <span class="pill ${recState(r)==='out' ? 'out' : ''}">${recState(r)}</span>
        </div>`) : html`<div class="empty">No records.</div>`}
    </div>`;
}

function RecordDetail({ row, onClose }) {
  return html`
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:flex-start;justify-content:center;padding:18px;z-index:40;overflow:auto">
      <div class="card" style="max-width:460px;width:100%;margin:24px 0 0">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span class="tag">RECORD</span>
          <button onClick=${onClose} style="background:none;border:none;color:var(--ink-dim);font-size:22px;cursor:pointer;line-height:1">✕</button>
        </div>
        <${SlipLine} label="Item" value=${html`${row.items?.name || 'Item'}${row.quantity > 1 ? ` ×${row.quantity}` : ''}`} />
        ${recCode(row) && html`<${SlipLine} label="Code" value=${html`<span class="mono" style="color:var(--hivis);font-weight:700">${recCode(row)}</span>`} />`}
        <${SlipLine} label="Type" value=${row.txn_type === 'issuance' ? 'Material issued' : 'Tool borrowed'} />
        <${SlipLine} label="Status" value=${recState(row)} />
        <${SlipLine} label=${row.txn_type === 'issuance' ? 'Receiver' : 'Borrower'} value=${row.employees?.name || row.employee_id} />
        ${row.project_vessel && html`<${SlipLine} label="Project / Vessel" value=${row.project_vessel} />`}
        ${row.issued_by && html`<${SlipLine} label=${row.txn_type === 'issuance' ? 'Issued by' : 'Released by'} value=${row.issued_by} />`}
        <${SlipLine} label=${row.txn_type === 'issuance' ? 'Issued' : 'Borrowed'} value=${html`<span class="mono" style="font-weight:600">${fmt(row.borrowed_at)}</span>`} />
        ${row.returned_at && html`<${SlipLine} label="Returned" value=${html`<span class="mono" style="font-weight:600">${fmt(row.returned_at)}</span>`} />`}
        ${row.received_by && html`<${SlipLine} label="Received by" value=${row.received_by} />`}
        ${row.return_condition && html`<${SlipLine} label="Condition" value=${row.return_condition} />`}
        ${row.notes && html`<${SlipLine} label="Notes" value=${row.notes} />`}
        <button class="btn ghost" style="margin-top:12px" onClick=${onClose}>Close</button>
      </div>
    </div>`;
}

// ---------- Recent issuances (materials, read-only) ----------
function RecentIssuances({ rows }) {
  if (!rows.length) return html`<div class="card"><div class="empty">No materials issued yet.</div></div>`;
  return html`
    <div class="card">
      ${rows.map(r => html`
        <div class="row" key=${r.id}>
          <div>
            <div class="name">${r.items?.name || 'Material'} ${r.quantity > 1 ? `×${r.quantity}` : ''}</div>
            <div class="sub">
              ${r.employees?.name || '—'}
              ${r.project_vessel ? ' · ' + r.project_vessel : ''}<br/>
              <span class="mono">issued ${fmt(r.borrowed_at)}</span>
            </div>
          </div>
        </div>`)}
    </div>`;
}

// ---------- Return slip (mirrors the borrow slip; confirm with passcode) ----------
function SlipLine({ label, value }) {
  return html`<div class="row"><div>
    <div class="sub">${label}</div>
    <div class="name">${value}</div>
  </div></div>`;
}
function ReturnSlip({ row, onConfirm, onCancel }) {
  const [pin, setPin] = useState('');
  const [receivedBy, setReceivedBy] = useState('');
  const [saving, setSaving] = useState(false);
  const go = async () => {
    if (!pin) return;
    setSaving(true);
    await onConfirm(row, pin, receivedBy, () => setSaving(false));
  };
  return html`
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:flex-start;justify-content:center;padding:18px;z-index:40;overflow:auto">
      <div class="card" style="max-width:460px;width:100%;margin:24px 0 0">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span class="tag">RETURN SLIP</span>
          <button onClick=${onCancel} style="background:none;border:none;color:var(--ink-dim);font-size:22px;cursor:pointer;line-height:1">✕</button>
        </div>
        <${SlipLine} label="Item" value=${html`${row.items?.name || 'Item'}${row.quantity > 1 ? ` ×${row.quantity}` : ''}`} />
        ${row.item_units?.unit_code && html`<${SlipLine} label="Unit code" value=${html`<span class="mono" style="color:var(--hivis);font-weight:700">${row.item_units.unit_code}</span>`} />`}
        ${!row.item_units?.unit_code && row.items?.item_code && html`<${SlipLine} label="Code" value=${html`<span class="mono" style="color:var(--hivis);font-weight:700">${row.items.item_code}</span>`} />`}
        <${SlipLine} label="Borrower" value=${row.employees?.name || '—'} />
        ${row.project_vessel && html`<${SlipLine} label="Project / Vessel" value=${row.project_vessel} />`}
        <${SlipLine} label="Borrowed" value=${html`<span class="mono" style="font-weight:600">${fmt(row.borrowed_at)}</span>`} />
        <div style="height:6px"></div>
        <${Field} label="Received by (staff)">
          <input value=${receivedBy} onInput=${e => setReceivedBy(e.target.value)} placeholder="Warehouse staff name" />
        <//>
        <${Field} label="Borrower passcode (sign to confirm return)">
          <input type="password" inputmode="numeric" autocomplete="off"
            value=${pin} onInput=${e => setPin(e.target.value)} placeholder="Enter passcode" />
        <//>
        <button class="btn" disabled=${saving} onClick=${go}>${saving ? 'Confirming…' : 'Confirm Return'}</button>
        <button class="btn ghost" style="margin-top:8px" onClick=${onCancel}>Cancel</button>
      </div>
    </div>`;
}

// ---------- Set stock (enter how many a site owns) ----------
function SetStock({ items, sites, defaultSite, onSaved, toast }) {
  const [itemId, setItemId] = useState('');
  const [siteId, setSiteId] = useState(defaultSite || '');
  const [qty, setQty]       = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setSiteId(defaultSite || ''); }, [defaultSite]);

  const submit = async () => {
    if (!itemId || !siteId) { toast('Pick an item and a site', true); return; }
    setSaving(true);
    try { await setStock(itemId, siteId, qty); toast('Stock updated'); setQty(''); onSaved(); }
    catch (e) { toast('Error: ' + e.message, true); }
    finally { setSaving(false); }
  };

  return html`
    <div class="card">
      <${Picker} label="Item" value=${itemId} onChange=${setItemId} placeholder="Select item…"
        options=${items.map(i => ({ id:i.id, label:`${i.name}${i.item_code? ' · '+i.item_code:''}` }))} />
      <${Field} label="Qty owned (at this location)">
        <input type="number" min="0" value=${qty} onInput=${e => setQty(e.target.value)} placeholder="0" />
      <//>
      <button class="btn ghost" disabled=${saving} onClick=${submit}>${saving ? 'Saving…' : 'Set Stock'}</button>
    </div>`;
}

// ---------- Per-site inventory summary ----------
function StockSummary({ rows, outCounts }) {
  const byItem = {};
  rows.forEach(r => {
    const it = r.items; if (!it) return;
    if (!byItem[it.id]) byItem[it.id] = { name: it.name, code: it.item_code, owned: 0 };
    byItem[it.id].owned += Number(r.qty_owned || 0);   // sums across sites when "All sites"
  });
  const list = Object.entries(byItem).map(([id, v]) => {
    const out = outCounts[id] || 0;
    return { id, ...v, out, avail: v.owned - out };
  }).sort((a, b) => a.name.localeCompare(b.name));

  if (!list.length) return html`<div class="card"><div class="empty">No stock recorded yet. Use “Set Stock” above to add quantities.</div></div>`;

  return html`
    <div class="card">
      <div style=${ST_ROW + 'border-bottom:1px solid var(--line);'}>
        <span style="font-size:11px;font-weight:800;letter-spacing:.5px;color:var(--ink-dim)">ITEM</span>
        <span style=${ST_NUM + 'font-size:11px;color:var(--ink-dim)'}>OWNED</span>
        <span style=${ST_NUM + 'font-size:11px;color:var(--ink-dim)'}>OUT</span>
        <span style=${ST_NUM + 'font-size:11px;color:var(--ink-dim)'}>AVAIL</span>
      </div>
      ${list.map(r => html`
        <div style=${ST_ROW} key=${r.id}>
          <span class="name">${r.name}${r.code ? html` <span class="mono" style="color:var(--ink-dim);font-weight:400">· ${r.code}</span>` : ''}</span>
          <span style=${ST_NUM}>${r.owned}</span>
          <span style=${ST_NUM + (r.out > 0 ? 'color:var(--hivis)' : 'color:var(--ink-dim)')}>${r.out}</span>
          <span style=${ST_NUM + (r.avail <= 0 ? 'color:var(--warn)' : '')}>${r.avail}</span>
        </div>`)}
    </div>`;
}

// ---------- Manage equipment (add tool + codes in one step) ----------
function ManageItems({ items, units, outUnitIds, fixedType, defaultSite, onAddUnit, onAddUnits, onRemoveUnit, onRemoveItem, onUpdatePrice, onChanged, toast }) {
  const isTool = fixedType !== 'issue';
  const [name, setName] = useState('');
  const [qty, setQty]   = useState('');
  const [price, setPrice] = useState('');
  const [siteId, setSiteId] = useState(defaultSite || '');
  const [saving, setSaving] = useState(false);
  const [openId, setOpenId] = useState(null);   // which tool is expanded
  const [newCode, setNewCode] = useState('');
  const [editPrice, setEditPrice] = useState('');
  // code generation (used by both the add form and the per-tool "add more")
  const [prefix, setPrefix] = useState('');
  const [count, setCount]   = useState('');
  const [digits, setDigits] = useState('3');
  useEffect(() => { setSiteId(defaultSite || ''); }, [defaultSite]);

  // next number to use for a prefix, given existing codes (so it continues the sequence)
  const nextStart = (someUnits, p, d) => {
    let max = 0;
    someUnits.forEach(u => {
      const c = u.unit_code || '';
      if (c.startsWith(p)) {
        const n = parseInt(c.slice(p.length), 10);
        if (!isNaN(n) && n > max) max = n;
      }
    });
    return max + 1;
  };
  const makeCodes = (p, startN, c, d) => {
    const out = [];
    for (let n = startN; n < startN + c; n++) out.push(p + String(n).padStart(d, '0'));
    return out;
  };

  // ----- add a new tool/material, optionally with a code sequence in one go -----
  const submit = async () => {
    if (!name.trim()) { toast('Enter a name', true); return; }
    const p = prefix.trim(), c = parseInt(count || '0', 10), d = parseInt(digits || '3', 10);
    setSaving(true);
    try {
      const item = await addItem({ name: name.trim(), item_code: null, unit: 'pcs', track_type: fixedType, price: price ? Number(price) : null });
      if (qty && siteId) await setStock(item.id, siteId, qty);
      if (isTool && p && c > 0) {                        // new tool → codes start at 1
        await onAddUnits(item.id, makeCodes(p, 1, c, d));
      }
      toast(isTool ? (p && c > 0 ? `Tool added with ${c} codes` : 'Tool added') : 'Material added');
      setName(''); setPrefix(''); setCount(''); setQty(''); setPrice('');
      onChanged();
    } catch (e) { toast('Error: ' + e.message, true); }
    finally { setSaving(false); }
  };

  // ----- add MORE equipment to an existing tool, continuing its own prefix -----
  const generateMore = async (itemId, myUnits) => {
    const c = parseInt(count || '0', 10);
    if (!c || c < 1) { toast('Enter how many', true); return; }
    let p, d;
    if (myUnits.length) {                          // continue the tool's existing prefix
      const sample = myUnits[0].unit_code;
      p = sample.replace(/\d+$/, '');
      d = (sample.match(/\d+$/)?.[0].length) || 3;
    } else {                                        // no codes yet → need a prefix once
      p = prefix.trim(); d = 3;
      if (!p) { toast('Enter a prefix (e.g. TL)', true); return; }
    }
    const startN = nextStart(myUnits, p, d);
    const existing = new Set((units || []).map(u => u.unit_code));
    const codes = makeCodes(p, startN, c, d).filter(cc => !existing.has(cc));
    if (!codes.length) { toast('Those codes already exist', true); return; }
    try {
      await onAddUnits(itemId, codes);
      toast(`Added ${codes.length} (${codes[0]}…)`);
      setCount(''); setPrefix('');
    } catch (e) { toast('Error: ' + e.message, true); }
  };

  const remove = async (i) => {
    const myUnits = (units || []).filter(u => u.item_id === i.id);
    const outNow = myUnits.filter(u => (outUnitIds || new Set()).has(u.id)).length;
    if (outNow > 0) {
      toast(`Can't remove "${i.name}" — ${outNow} unit${outNow>1?'s are':' is'} still borrowed. Return first.`, true);
      return;
    }
    const msg = `Remove "${i.name}"${myUnits.length ? ` and its ${myUnits.length} code${myUnits.length>1?'s':''}` : ''}?\n\nThis cannot be undone.`;
    if (!confirm(msg)) return;
    try { await onRemoveItem(i); toast('Removed'); }
    catch (e) { toast('Error: ' + e.message, true); }
  };

  const addCode = async (itemId) => {
    if (!newCode.trim()) { toast('Enter a unit code', true); return; }
    try { await onAddUnit(itemId, newCode.trim()); setNewCode(''); }
    catch (e) { toast('Error: ' + e.message, true); }
  };

  const savePrice = async (itemId) => {
    try { await onUpdatePrice(itemId, editPrice); toast('Price saved'); setEditPrice(''); }
    catch (e) { toast('Error: ' + e.message, true); }
  };

  // live preview for the ADD form (new tool starts at 1)
  const addPreview = (() => {
    const p = prefix.trim(), c = parseInt(count || '0', 10), d = parseInt(digits || '3', 10);
    if (!isTool || !p || !c) return '';
    const code = (n) => p + String(n).padStart(d, '0');
    return c === 1 ? code(1) : `${code(1)} … ${code(c)}  (${c} codes)`;
  })();

  return html`
    <div class="card">
      <${Field} label=${isTool ? 'Tool / equipment name' : 'Material name'}>
        <input value=${name} onInput=${e => setName(e.target.value)} placeholder=${isTool ? 'e.g. Trouble Light' : 'e.g. Welding Rod'} />
      <//>

      ${isTool && html`
        <label>Codes (optional — auto-generated)</label>
        <div style="display:flex;gap:8px">
          <input value=${prefix} onInput=${e => setPrefix(e.target.value)} placeholder="Prefix e.g. TL" style="flex:1.4" />
          <input type="number" value=${count} onInput=${e => setCount(e.target.value)} placeholder="How many" style="flex:1" />
        </div>
        ${addPreview && html`<div class="note" style="margin:6px 0 12px">Will create: <span class="mono">${addPreview}</span></div>`}
      `}

      <${Field} label="Replacement price ₱ (optional)">
        <input type="number" min="0" value=${price} onInput=${e => setPrice(e.target.value)} placeholder="0" />
      <//>
      <${Field} label="Starting qty at this location (optional)">
        <input type="number" min="0" value=${qty} onInput=${e => setQty(e.target.value)} placeholder="0" />
      <//>
      <button class="btn" disabled=${saving} onClick=${submit}>${saving ? 'Adding…' : (isTool ? 'Add Tool' : 'Add Material')}</button>
    </div>

    <div class="card">
      <label>${isTool ? 'Tools' : 'Materials'} (${items.length})</label>
      ${items.length ? items.map(i => {
        const myUnits = (units || []).filter(u => u.item_id === i.id);
        const expanded = openId === i.id;
        return html`
        <div key=${i.id} style="border-bottom:1px solid var(--line)">
          <div class="row" style="border-bottom:none">
            <div onClick=${isTool ? (() => { setOpenId(expanded ? null : i.id); setPrefix(''); setCount(''); setEditPrice(''); }) : null} style=${isTool ? 'cursor:pointer' : ''}>
              <div class="name">${i.name} ${isTool ? html`<span class="mono" style="color:var(--ink-dim);font-weight:400">${myUnits.length ? '· ' + myUnits.length + ' code' + (myUnits.length>1?'s':'') : '· tap to add codes'}</span>` : ''}</div>
              <div class="sub">${isTool ? 'Tool' : 'Material'}${i.price ? ' · ' + peso(i.price) : ''}</div>
            </div>
            <button class="ret" onClick=${() => remove(i)}>Remove</button>
          </div>
          ${isTool && expanded && html`
            <div style="padding:4px 0 14px">
              <div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:10px">
                <div style="flex:1">
                  <label>Replacement price ₱</label>
                  <input type="number" min="0" value=${editPrice} onInput=${e => setEditPrice(e.target.value)} placeholder=${i.price || '0'} />
                </div>
                <button class="ret" onClick=${() => savePrice(i.id)}>Save ₱</button>
              </div>

              ${myUnits.map(u => html`
                <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0">
                  <span class="mono">${u.unit_code}</span>
                  <button onClick=${() => onRemoveUnit(u.id)} style="background:none;border:none;color:var(--warn);cursor:pointer;font-size:13px">remove</button>
                </div>`)}

              <div style="border-top:1px solid var(--line);margin-top:8px;padding-top:10px">
                <label>Add more equipment</label>
                ${myUnits.length === 0 && html`
                  <input value=${prefix} onInput=${e => setPrefix(e.target.value)} placeholder="Prefix e.g. TL" style="margin-bottom:8px" />`}
                <div style="display:flex;gap:8px">
                  <input type="number" value=${count} onInput=${e => setCount(e.target.value)} placeholder="How many" style="flex:1" />
                  <button class="btn" style="flex:1" onClick=${() => generateMore(i.id, myUnits)}>Add Equipment</button>
                </div>
                ${myUnits.length > 0 && html`<div class="note" style="margin-top:6px">Continues from <span class="mono">${(() => { const s = myUnits[0].unit_code; const p = s.replace(/\d+$/,''); const d = (s.match(/\d+$/)?.[0].length)||3; return p + String(nextStart(myUnits, p, d)).padStart(d,'0'); })()}</span></div>`}
              </div>
            </div>`}
        </div>`;
      }) : html`<div class="empty">No equipment yet. Add some above.</div>`}
    </div>`;
}

// ---------- App shell ----------
function App() {
  const [section, setSection] = useState('borrow'); // borrow | issue  (top level)
  const [tab, setTab] = useState('form');           // form | active | stock | items (sub level)
  const [sites, setSites] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [items, setItems] = useState([]);
  const [siteFilter, setSiteFilter] = useState('');
  const [open, setOpen] = useState([]);
  const [issues, setIssues] = useState([]);
  const [stockRows, setStockRows] = useState([]);
  const [outCounts, setOutCounts] = useState({});
  const [unitsRows, setUnitsRows] = useState([]);
  const [returning, setReturning] = useState(null);  // borrow row being returned
  const [records, setRecords] = useState([]);
  const [recordFilter, setRecordFilter] = useState('all');
  const [recDetail, setRecDetail] = useState(null);
  const [toast, setToast] = useState(null);
  const [fatal, setFatal] = useState(null);

  const flash = (msg, err=false) => { setToast({ msg, err }); setTimeout(() => setToast(null), 2600); };

  const loadOpen = useCallback(async () => {
    try { setOpen(await getOpenBorrows(siteFilter)); }
    catch (e) { flash('Load failed: ' + e.message, true); }
  }, [siteFilter]);

  const loadIssues = useCallback(async () => {
    try { setIssues(await getRecentIssuances(siteFilter)); }
    catch (e) { flash('Load failed: ' + e.message, true); }
  }, [siteFilter]);

  const loadStock = useCallback(async () => {
    try {
      const [st, oc] = await Promise.all([getStock(siteFilter), getOutCounts(siteFilter)]);
      setStockRows(st); setOutCounts(oc);
    } catch (e) { flash('Stock load failed: ' + e.message, true); }
  }, [siteFilter]);

  const loadItems = useCallback(async () => {
    try { setItems(await getItems()); } catch (e) { flash('Items load failed: ' + e.message, true); }
  }, []);

  const loadUnits = useCallback(async () => {
    try { setUnitsRows(await getUnits(siteFilter)); } catch (e) { flash('Units load failed: ' + e.message, true); }
  }, [siteFilter]);

  const loadRecords = useCallback(async () => {
    try { setRecords(await getRecords(siteFilter)); } catch (e) { flash('Records load failed: ' + e.message, true); }
  }, [siteFilter]);

  useEffect(() => { (async () => {
    try {
      const [s, e, i] = await Promise.all([getSites(), getEmployees(), getItems()]);
      setSites(s); setEmployees(e); setItems(i);
      // Lock to the location saved on THIS device (set once on first use).
      const saved = localStorage.getItem('rsr_location');
      const match = saved && s.find(x => x.name === saved);
      if (match) setSiteFilter(match.id);
      // if none saved/invalid, leave empty → the one-time chooser shows
    } catch (err) {
      setFatal(err.message);   // usually a missing anon key or RLS — see banner
    }
  })(); }, []);

  useEffect(() => { loadOpen(); }, [loadOpen]);
  useEffect(() => { loadIssues(); }, [loadIssues]);
  useEffect(() => { loadStock(); }, [loadStock]);
  useEffect(() => { loadUnits(); }, [loadUnits]);
  useEffect(() => { loadRecords(); }, [loadRecords]);

  const outUnitIds = new Set(open.map(o => o.unit_id).filter(Boolean));

  const addUnitFor = async (itemId, code) => {
    await addUnit({ item_id: itemId, site_id: siteFilter || null, unit_code: code });
    loadUnits();
  };
  const addUnitsFor = async (itemId, codes) => {
    await addUnits(codes.map(c => ({ item_id: itemId, site_id: siteFilter || null, unit_code: c })));
    loadUnits();
  };
  const removeUnitById = async (id) => { await deactivateUnit(id); loadUnits(); };
  const repairUnit = async (id, defect, eta) => { await sendToRepair(id, defect, eta); loadUnits(); };
  const unrepairUnit = async (id) => { await markRepaired(id); loadUnits(); };
  const setItemPrice = async (id, price) => { await updateItemPrice(id, price); loadItems(); };
  const removeItemFull = async (item) => {
    try { await deleteUnitsForItem(item.id); }   // free its codes (skips if borrow history blocks it)
    catch (_) { /* referenced by past borrows — leave codes, just hide the tool */ }
    await deactivateItem(item.id);
    loadItems(); loadUnits(); loadStock();
  };

  const doReturn = (r) => setReturning(r);     // open the return slip

  const confirmReturn = async (row, pin, receivedBy, done) => {
    try {
      const ok = await verifyPin(row.employee_id, pin);
      if (!ok) { flash('Wrong passcode', true); done(); return; }
      await returnItem(row.id, 'Returned', receivedBy);
      flash('Returned'); setReturning(null); loadOpen();
    } catch (e) { flash('Error: ' + e.message, true); done(); }
  };

  const chooseLocation = (site) => {            // set once for this device
    localStorage.setItem('rsr_location', site.name);
    setSiteFilter(site.id);
  };
  const changeLocation = () => {                // rarely needed; for fixing a mistake
    if (!confirm('Change this tablet’s location? Only do this if it was set wrong.')) return;
    localStorage.removeItem('rsr_location');
    setSiteFilter('');
  };

  const activeSite = sites.find(s => s.id === siteFilter);

  return html`
    <header class="app">
      <div class="wrap">
        <div class="brand" style="display:flex;align-items:center;justify-content:space-between">
          <span><b>RSR</b><span class="tag">BORROW · ISSUE</span></span>
          <span style="display:flex;align-items:center;gap:10px">
            ${activeSite && html`<span class="tag" style="background:var(--panel-2);color:var(--ink)">📍 ${activeSite.name}</span>`}
            ${activeSite && html`<button onClick=${changeLocation} title="Change location"
              style="background:none;border:none;color:var(--ink-dim);font-size:13px;cursor:pointer">change</button>`}
            <a href="../" style="color:var(--ink-dim);text-decoration:none;font-size:13px;font-weight:700">⌂ Home</a>
          </span>
        </div>
      </div>
    </header>

    <div class="wrap">
      ${fatal && html`<div class="banner">
        Couldn't reach Supabase: <b>${fatal}</b>.<br/>
        Check that you pasted your <b>anon public key</b> in <span class="mono">supabase.js</span>
        and that you ran <span class="mono">schema.sql</span>.
      </div>`}

      ${!fatal && !activeSite && sites.length > 0 && html`
        <div class="card" style="text-align:center;margin-top:30px">
          <h2 style="margin:6px 0 4px">Set up this tablet</h2>
          <p class="note" style="margin-bottom:18px">Which location is this device for? This is set once and remembered on this tablet.</p>
          ${sites.map(s => html`
            <button key=${s.id} class="btn" style="margin-bottom:10px" onClick=${() => chooseLocation(s)}>📍 ${s.name}</button>`)}
        </div>`}

      ${activeSite && html`<div>

      <div class="tabs" style="margin-bottom:10px;flex-wrap:wrap">
        <button class=${section==='borrow'?'on':''} onClick=${() => { setSection('borrow'); setTab('form'); }}>TOOL INVENTORY</button>
        <button class=${section==='issue'?'on':''}  onClick=${() => { setSection('issue');  setTab('form'); }}>ISSUE</button>
        <button class=${section==='records'?'on':''} onClick=${() => setSection('records')}>RECORDS</button>
      </div>

      ${section === 'records' && html`<${Records} rows=${records}
        filter=${recordFilter} setFilter=${setRecordFilter} onOpen=${setRecDetail} />`}

      ${section !== 'records' && (() => {
        const isBorrow = section === 'borrow';
        const mode = isBorrow ? 'borrow' : 'issuance';
        const sectionItems = items.filter(i => isBorrow ? i.track_type !== 'issue' : i.track_type === 'issue');
        const sectionStock = stockRows.filter(r => isBorrow ? r.items?.track_type !== 'issue' : r.items?.track_type === 'issue');
        const reloadForm = isBorrow ? loadOpen : loadIssues;
        return html`
        <div class="tabs" style="flex-wrap:wrap">
          <button class=${tab==='form'?'on':''}   onClick=${() => setTab('form')}>${isBorrow ? 'Borrow Slip' : 'Issue'}</button>
          <button class=${tab==='active'?'on':''} onClick=${() => setTab('active')}>${isBorrow ? `Return Slip (${open.length})` : `Recent (${issues.length})`}</button>
          <button class=${tab==='stock'?'on':''}  onClick=${() => setTab('stock')}>${isBorrow ? 'In Store' : 'Stock'}</button>
          <button class=${tab==='items'?'on':''}  onClick=${() => setTab('items')}>${isBorrow ? 'Register Tools' : 'Items'}</button>
          ${isBorrow && html`<button class=${tab==='repair'?'on':''} onClick=${() => setTab('repair')}>Repair</button>`}
        </div>

        ${tab==='form' && html`<${NewTransaction} mode=${mode}
          sites=${sites} employees=${employees} items=${sectionItems}
          units=${unitsRows} outUnitIds=${outUnitIds}
          defaultSite=${siteFilter} onSaved=${reloadForm} toast=${flash} />`}

        ${tab==='active' && (isBorrow
          ? html`<${ActiveBorrows} rows=${open} onReturn=${doReturn} />`
          : html`<${RecentIssuances} rows=${issues} />`)}

        ${tab==='stock' && (isBorrow
          ? html`<${ToolStore} items=${sectionItems} units=${unitsRows} outUnitIds=${outUnitIds}
              stockRows=${sectionStock} outCounts=${outCounts} />`
          : html`<div>
              <${SetStock} items=${sectionItems} sites=${sites} defaultSite=${siteFilter}
                onSaved=${loadStock} toast=${flash} />
              <${StockSummary} rows=${sectionStock} outCounts=${outCounts} />
            </div>`)}

        ${tab==='items' && html`<${ManageItems} items=${sectionItems} units=${unitsRows} outUnitIds=${outUnitIds} fixedType=${isBorrow ? 'borrow' : 'issue'}
          defaultSite=${siteFilter} onAddUnit=${addUnitFor} onAddUnits=${addUnitsFor} onRemoveUnit=${removeUnitById} onRemoveItem=${removeItemFull} onUpdatePrice=${setItemPrice}
          onChanged=${() => { loadItems(); loadStock(); }} toast=${flash} />`}

        ${tab==='repair' && isBorrow && html`<${ForRepair} items=${sectionItems} units=${unitsRows} outUnitIds=${outUnitIds}
          onSendRepair=${repairUnit} onRepaired=${unrepairUnit} toast=${flash} />`}
        `;
      })()}

      ${section !== 'records' && html`<p class="note">Tip: add your ${section==='issue' ? 'materials' : 'tools'} in the <b>Items</b> tab — they appear in the dropdowns automatically.</p>`}
      </div>`}
    </div>

    ${returning && html`<${ReturnSlip} row=${returning}
      onConfirm=${confirmReturn} onCancel=${() => setReturning(null)} />`}

    ${recDetail && html`<${RecordDetail} row=${recDetail} onClose=${() => setRecDetail(null)} />`}

    ${toast && html`<div class=${'toast' + (toast.err?' err':'')}>${toast.msg}</div>`}
  `;
}

render(html`<${App} />`, document.getElementById('app'));
