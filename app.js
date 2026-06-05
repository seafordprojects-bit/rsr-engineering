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
  getSites, getEmployees, getItems,
  createTransaction,
} from './supabase.js';

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
    .select('id, quantity, borrowed_at, due_at, project_vessel, issued_by, employee_id, unit_id, ' +
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
    .select('id, unit_code, item_id')
    .eq('active', true)
    .order('unit_code')
    .limit(3000);
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
  return html`
    <${Field} label=${label}>
      <select value=${value} onChange=${e => onChange(e.target.value)}>
        <option value="">${placeholder}</option>
        ${options.map(o => html`<option value=${o.id}>${o.label}</option>`)}
      </select>
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
  const availableUnits = itemUnits.filter(u => !outUnitIds.has(u.id) && !inCart.has(u.id));

  const pickItem = (v) => { setItemId(v); setUnitId(''); };

  const itemName = (id) => (items.find(i => i.id === id)?.name) || 'Item';
  const itemCode = (id) => (items.find(i => i.id === id)?.item_code) || '';
  const unitCode = (id) => (units.find(u => u.id === id)?.unit_code) || '';

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
              <div class="name">${c.label}</div>
              <button class="ret" onClick=${() => removeLine(idx)}>✕</button>
            </div>`)}
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

      <${Field} label=${isBorrow ? 'Borrower passcode (sign here)' : 'Receiver passcode (sign here)'}>
        <input type="password" inputmode="numeric" autocomplete="off"
          value=${pin} onInput=${e => setPin(e.target.value)} placeholder="Enter passcode to confirm" />
      <//>

      <button class="btn" disabled=${saving || !cart.length} onClick=${submit}>
        ${saving ? 'Saving…' : (isBorrow ? `Borrow Out (${cart.length})` : `Issue (${cart.length})`)}
      </button>
    </div>`;
}

// ---------- Active borrows list ----------
function ActiveBorrows({ rows, onReturn }) {
  if (!rows.length) return html`<div class="card"><div class="empty">No tools currently out.</div></div>`;
  return html`
    <div class="card">
      ${rows.map(r => html`
        <div class="row" key=${r.id}>
          <div>
            <div class="name">${r.items?.name || 'Item'} ${r.item_units?.unit_code ? html`<span class="mono" style="color:var(--hivis)">· ${r.item_units.unit_code}</span>` : (r.items?.item_code ? html`<span class="mono" style="color:var(--hivis)">· ${r.items.item_code}</span>` : (r.quantity > 1 ? `×${r.quantity}` : ''))}</div>
            <div class="sub">
              ${r.employees?.name || '—'}
              ${r.project_vessel ? ' · ' + r.project_vessel : ''}<br/>
              <span class="mono">out ${fmt(r.borrowed_at)}</span>
            </div>
          </div>
          <button class="ret" onClick=${() => onReturn(r)}>Return</button>
        </div>`)}
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

// ---------- Manage equipment (add / list / remove + unit codes) ----------
function ManageItems({ items, units, fixedType, defaultSite, onAddUnit, onAddUnits, onRemoveUnit, onChanged, toast }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [unit, setUnit] = useState('pcs');
  const [qty, setQty]   = useState('');
  const [siteId, setSiteId] = useState(defaultSite || '');
  const [saving, setSaving] = useState(false);
  const [openId, setOpenId] = useState(null);   // which tool is expanded for unit codes
  const [newCode, setNewCode] = useState('');
  // auto-generate sequence
  const [prefix, setPrefix] = useState('');
  const [start, setStart]   = useState('1');
  const [count, setCount]   = useState('');
  const [digits, setDigits] = useState('3');
  useEffect(() => { setSiteId(defaultSite || ''); }, [defaultSite]);

  const preview = (() => {
    const p = prefix.trim(); const s = parseInt(start || '1', 10);
    const c = parseInt(count || '0', 10); const d = parseInt(digits || '3', 10);
    if (!p || !c) return '';
    const code = (n) => p + String(n).padStart(d, '0');
    return c === 1 ? code(s) : `${code(s)} … ${code(s + c - 1)}  (${c} codes)`;
  })();

  const generate = async (itemId) => {
    const p = prefix.trim();
    const s = parseInt(start || '1', 10);
    const c = parseInt(count || '0', 10);
    const d = parseInt(digits || '3', 10);
    if (!p) { toast('Enter a prefix (e.g. TL)', true); return; }
    if (!c || c < 1) { toast('Enter how many', true); return; }
    const existing = new Set((units || []).map(u => u.unit_code));
    const codes = [];
    for (let n = s; n < s + c; n++) {
      const cc = p + String(n).padStart(d, '0');
      if (!existing.has(cc)) codes.push(cc);
    }
    if (!codes.length) { toast('Those codes already exist', true); return; }
    try {
      await onAddUnits(itemId, codes);
      toast(`Added ${codes.length} code${codes.length>1?'s':''}`);
      setPrefix(''); setCount('');
    } catch (e) { toast('Error: ' + e.message, true); }
  };

  const submit = async () => {
    if (!name.trim()) { toast('Enter an equipment name', true); return; }
    setSaving(true);
    try {
      const item = await addItem({
        name: name.trim(),
        item_code: code.trim() || null,
        unit: unit.trim() || 'pcs',
        track_type: fixedType,
      });
      if (qty && siteId) await setStock(item.id, siteId, qty);  // optional one-step starting stock
      toast('Equipment added');
      setName(''); setCode(''); setQty('');
      onChanged();
    } catch (e) { toast('Error: ' + e.message, true); }
    finally { setSaving(false); }
  };

  const remove = async (i) => {
    if (!confirm(`Remove "${i.name}" from the list?`)) return;
    try { await deactivateItem(i.id); toast('Removed'); onChanged(); }
    catch (e) { toast('Error: ' + e.message, true); }
  };

  const addCode = async (itemId) => {
    if (!newCode.trim()) { toast('Enter a unit code', true); return; }
    try { await onAddUnit(itemId, newCode.trim()); setNewCode(''); }
    catch (e) { toast('Error: ' + e.message, true); }
  };

  const isTool = fixedType !== 'issue';

  return html`
    <div class="card">
      <${Field} label=${fixedType === 'issue' ? 'Material name' : 'Tool / equipment name'}>
        <input value=${name} onInput=${e => setName(e.target.value)} placeholder=${fixedType === 'issue' ? 'e.g. Welding Rod' : 'e.g. Angle Grinder'} />
      <//>
      <${Field} label="Code (optional)">
        <input value=${code} onInput=${e => setCode(e.target.value)} placeholder=${fixedType === 'issue' ? 'MAT-001' : 'TOOL-001'} />
      <//>
      <${Field} label="Starting qty at this location (optional)">
        <input type="number" min="0" value=${qty} onInput=${e => setQty(e.target.value)} placeholder="0" />
      <//>
      <button class="btn" disabled=${saving} onClick=${submit}>${saving ? 'Adding…' : (fixedType === 'issue' ? 'Add Material' : 'Add Tool')}</button>
    </div>

    <div class="card">
      <label>${fixedType === 'issue' ? 'Materials' : 'Tools'} (${items.length})</label>
      ${items.length ? items.map(i => {
        const myUnits = (units || []).filter(u => u.item_id === i.id);
        const expanded = openId === i.id;
        return html`
        <div key=${i.id} style="border-bottom:1px solid var(--line)">
          <div class="row" style="border-bottom:none">
            <div onClick=${isTool ? (() => setOpenId(expanded ? null : i.id)) : null} style=${isTool ? 'cursor:pointer' : ''}>
              <div class="name">${i.name} ${isTool ? html`<span class="mono" style="color:var(--ink-dim);font-weight:400">${myUnits.length ? '· ' + myUnits.length + ' unit' + (myUnits.length>1?'s':'') : '· tap to add codes'}</span>` : ''}</div>
              <div class="sub">${isTool ? 'Tool' : 'Material'}${i.item_code ? ' · ' + i.item_code : ''}</div>
            </div>
            <button class="ret" onClick=${() => remove(i)}>Remove</button>
          </div>
          ${isTool && expanded && html`
            <div style="padding:4px 0 14px">
              ${myUnits.map(u => html`
                <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0">
                  <span class="mono">${u.unit_code}</span>
                  <button onClick=${() => onRemoveUnit(u.id)} style="background:none;border:none;color:var(--warn);cursor:pointer;font-size:13px">remove</button>
                </div>`)}

              <div style="border-top:1px solid var(--line);margin-top:8px;padding-top:10px">
                <label>Auto-generate a sequence</label>
                <div style="display:flex;gap:8px">
                  <input value=${prefix} onInput=${e => setPrefix(e.target.value)} placeholder="Prefix e.g. TL" style="flex:1.4" />
                  <input type="number" value=${start} onInput=${e => setStart(e.target.value)} placeholder="Start" style="flex:1" />
                  <input type="number" value=${count} onInput=${e => setCount(e.target.value)} placeholder="How many" style="flex:1" />
                </div>
                <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
                  <input type="number" value=${digits} onInput=${e => setDigits(e.target.value)} placeholder="Digits" style="width:90px" />
                  <button class="btn" style="flex:1" onClick=${() => generate(i.id)}>Generate</button>
                </div>
                ${preview && html`<div class="note" style="margin-top:6px">Will create: <span class="mono">${preview}</span></div>`}
              </div>

              <div style="display:flex;gap:8px;margin-top:12px">
                <input value=${newCode} onInput=${e => setNewCode(e.target.value)} placeholder="or add one: GR-001" style="flex:1" />
                <button class="ret" onClick=${() => addCode(i.id)}>+ Code</button>
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
          ${activeSite && html`<span style="display:flex;align-items:center;gap:8px">
            <span class="tag" style="background:var(--panel-2);color:var(--ink)">📍 ${activeSite.name}</span>
            <button onClick=${changeLocation} title="Change location"
              style="background:none;border:none;color:var(--ink-dim);font-size:13px;cursor:pointer">change</button>
          </span>`}
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

      <div class="tabs" style="margin-bottom:10px">
        <button class=${section==='borrow'?'on':''} onClick=${() => { setSection('borrow'); setTab('form'); }}>TOOL INVENTORY</button>
        <button class=${section==='issue'?'on':''}  onClick=${() => { setSection('issue');  setTab('form'); }}>ISSUE</button>
      </div>

      ${(() => {
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
        </div>

        ${tab==='form' && html`<${NewTransaction} mode=${mode}
          sites=${sites} employees=${employees} items=${sectionItems}
          units=${unitsRows} outUnitIds=${outUnitIds}
          defaultSite=${siteFilter} onSaved=${reloadForm} toast=${flash} />`}

        ${tab==='active' && (isBorrow
          ? html`<${ActiveBorrows} rows=${open} onReturn=${doReturn} />`
          : html`<${RecentIssuances} rows=${issues} />`)}

        ${tab==='stock' && html`<div>
          <${SetStock} items=${sectionItems} sites=${sites} defaultSite=${siteFilter}
            onSaved=${loadStock} toast=${flash} />
          <${StockSummary} rows=${sectionStock} outCounts=${outCounts} />
        </div>`}

        ${tab==='items' && html`<${ManageItems} items=${sectionItems} units=${unitsRows} fixedType=${isBorrow ? 'borrow' : 'issue'}
          defaultSite=${siteFilter} onAddUnit=${addUnitFor} onAddUnits=${addUnitsFor} onRemoveUnit=${removeUnitById}
          onChanged=${() => { loadItems(); loadStock(); }} toast=${flash} />`}
        `;
      })()}

      <p class="note">Tip: add your ${section==='issue' ? 'materials' : 'tools'} in the <b>Items</b> tab — they appear in the dropdowns automatically.</p>
      </div>`}
    </div>

    ${returning && html`<${ReturnSlip} row=${returning}
      onConfirm=${confirmReturn} onCancel=${() => setReturning(null)} />`}

    ${toast && html`<div class=${'toast' + (toast.err?' err':'')}>${toast.msg}</div>`}
  `;
}

render(html`<${App} />`, document.getElementById('app'));
