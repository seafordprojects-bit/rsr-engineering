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
  getSites, getEmployees, getItems, getOpenBorrows,
  createTransaction, returnItem,
} from './supabase.js';

const fmt = (ts) => ts ? new Date(ts).toLocaleString('en-PH',
  { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';

// ---- stock data (kept here so supabase.js stays untouched) ----
async function getStock(siteId) {
  let q = supabase
    .from('site_inventory')
    .select('qty_owned, site_id, items(id, item_code, name, unit)')
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

const ST_ROW = 'display:grid;grid-template-columns:1fr 58px 44px 58px;gap:8px;align-items:center;padding:11px 0;border-bottom:1px solid var(--line);';
const ST_NUM = 'text-align:right;font-family:"JetBrains Mono",monospace;font-weight:700;';

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

// ---------- New borrow / issuance form ----------
function NewTransaction({ mode, sites, employees, items, defaultSite, onSaved, toast }) {
  const isBorrow = mode === 'borrow';
  const [employeeId, setEmployeeId] = useState('');
  const [itemId, setItemId]   = useState('');
  const [siteId, setSiteId]   = useState(defaultSite || '');
  const [qty, setQty]         = useState('1');
  const [issuedBy, setIssuedBy] = useState('');
  const [project, setProject]   = useState('');
  const [due, setDue]           = useState('');
  const [notes, setNotes]       = useState('');
  const [saving, setSaving]     = useState(false);

  useEffect(() => { setSiteId(defaultSite || ''); }, [defaultSite]);

  const reset = () => { setEmployeeId(''); setItemId(''); setQty('1');
    setIssuedBy(''); setProject(''); setDue(''); setNotes(''); };

  const submit = async () => {
    if (!employeeId || !itemId) { toast('Pick an employee and an item', true); return; }
    setSaving(true);
    try {
      // NOTE: no borrowed_at sent — the DB stamps server time on insert.
      await createTransaction({
        txn_type: mode,
        employee_id: employeeId,
        item_id: itemId,
        site_id: siteId || null,
        quantity: Number(qty) || 1,
        status: isBorrow ? 'out' : 'issued',
        issued_by: issuedBy || null,
        project_vessel: project || null,
        due_at: isBorrow && due ? new Date(due).toISOString() : null,
        notes: notes || null,
      });
      toast(isBorrow ? 'Tool borrowed out' : 'Material issued');
      reset();
      onSaved();
    } catch (e) {
      toast('Error: ' + e.message, true);
    } finally { setSaving(false); }
  };

  return html`
    <div class="card">
      <${Picker} label="Borrower / Receiver" value=${employeeId} onChange=${setEmployeeId}
        placeholder="Select employee…"
        options=${employees.map(e => ({ id:e.id, label:`${e.name}${e.id? ' · '+e.id:''}` }))} />

      <${Picker} label="Item" value=${itemId} onChange=${setItemId}
        placeholder="Select item…"
        options=${items.map(i => ({ id:i.id, label:`${i.name}${i.item_code? ' · '+i.item_code:''}` }))} />

      <div class="two">
        <${Field} label="Quantity">
          <input type="number" min="1" value=${qty} onInput=${e => setQty(e.target.value)} />
        <//>
        <${Picker} label="Site" value=${siteId} onChange=${setSiteId}
          placeholder="Site…" options=${sites.map(s => ({ id:s.id, label:s.name }))} />
      </div>

      <${Field} label=${isBorrow ? 'Released by' : 'Issued by'}>
        <input value=${issuedBy} onInput=${e => setIssuedBy(e.target.value)} placeholder="Warehouse staff name" />
      <//>

      <${Field} label="Project / Vessel">
        <input value=${project} onInput=${e => setProject(e.target.value)} placeholder="e.g. MV Seafarer drydock" />
      <//>

      ${isBorrow && html`
        <${Field} label="Expected return (optional)">
          <input type="datetime-local" value=${due} onInput=${e => setDue(e.target.value)} />
        <//>`}

      <${Field} label="Notes">
        <textarea rows="2" value=${notes} onInput=${e => setNotes(e.target.value)}></textarea>
      <//>

      <button class="btn" disabled=${saving} onClick=${submit}>
        ${saving ? 'Saving…' : (isBorrow ? 'Borrow Out' : 'Issue Material')}
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
            <div class="name">${r.items?.name || 'Item'} ${r.quantity > 1 ? `×${r.quantity}` : ''}</div>
            <div class="sub">
              ${r.employees?.name || '—'}
              ${r.project_vessel ? ' · ' + r.project_vessel : ''}<br/>
              <span class="mono">out ${fmt(r.borrowed_at)}${r.due_at ? ' · due ' + fmt(r.due_at) : ''}</span>
            </div>
          </div>
          <button class="ret" onClick=${() => onReturn(r)}>Return</button>
        </div>`)}
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
      <div class="two">
        <${Picker} label="Site" value=${siteId} onChange=${setSiteId} placeholder="Site…"
          options=${sites.map(s => ({ id:s.id, label:s.name }))} />
        <${Field} label="Qty owned">
          <input type="number" min="0" value=${qty} onInput=${e => setQty(e.target.value)} placeholder="0" />
        <//>
      </div>
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

// ---------- App shell ----------
function App() {
  const [tab, setTab] = useState('borrow');     // borrow | issue | active
  const [sites, setSites] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [items, setItems] = useState([]);
  const [siteFilter, setSiteFilter] = useState('');
  const [open, setOpen] = useState([]);
  const [stockRows, setStockRows] = useState([]);
  const [outCounts, setOutCounts] = useState({});
  const [toast, setToast] = useState(null);
  const [fatal, setFatal] = useState(null);

  const flash = (msg, err=false) => { setToast({ msg, err }); setTimeout(() => setToast(null), 2600); };

  const loadOpen = useCallback(async () => {
    try { setOpen(await getOpenBorrows(siteFilter)); }
    catch (e) { flash('Load failed: ' + e.message, true); }
  }, [siteFilter]);

  const loadStock = useCallback(async () => {
    try {
      const [st, oc] = await Promise.all([getStock(siteFilter), getOutCounts(siteFilter)]);
      setStockRows(st); setOutCounts(oc);
    } catch (e) { flash('Stock load failed: ' + e.message, true); }
  }, [siteFilter]);

  useEffect(() => { (async () => {
    try {
      const [s, e, i] = await Promise.all([getSites(), getEmployees(), getItems()]);
      setSites(s); setEmployees(e); setItems(i);
    } catch (err) {
      setFatal(err.message);   // usually a missing anon key or RLS — see banner
    }
  })(); }, []);

  useEffect(() => { loadOpen(); }, [loadOpen]);
  useEffect(() => { loadStock(); }, [loadStock]);

  const doReturn = async (r) => {
    const cond = prompt(`Return "${r.items?.name}". Condition? (optional)`, 'OK');
    if (cond === null) return;
    try { await returnItem(r.id, cond); flash('Returned'); loadOpen(); }
    catch (e) { flash('Error: ' + e.message, true); }
  };

  return html`
    <header class="app">
      <div class="wrap">
        <div class="brand"><b>RSR</b><span class="tag">BORROW · ISSUE</span></div>
        <div class="site-row">
          <select value=${siteFilter} onChange=${e => setSiteFilter(e.target.value)}>
            <option value="">All sites</option>
            ${sites.map(s => html`<option value=${s.id}>${s.name}</option>`)}
          </select>
        </div>
      </div>
    </header>

    <div class="wrap">
      ${fatal && html`<div class="banner">
        Couldn't reach Supabase: <b>${fatal}</b>.<br/>
        Check that you pasted your <b>anon public key</b> in <span class="mono">supabase.js</span>
        and that you ran <span class="mono">schema.sql</span>.
      </div>`}

      <div class="tabs">
        <button class=${tab==='borrow'?'on':''} onClick=${() => setTab('borrow')}>Borrow</button>
        <button class=${tab==='issue'?'on':''}  onClick=${() => setTab('issue')}>Issue</button>
        <button class=${tab==='active'?'on':''} onClick=${() => setTab('active')}>Active (${open.length})</button>
        <button class=${tab==='stock'?'on':''}  onClick=${() => setTab('stock')}>Stock</button>
      </div>

      ${tab==='borrow' && html`<${NewTransaction} mode="borrow"
        sites=${sites} employees=${employees} items=${items}
        defaultSite=${siteFilter} onSaved=${loadOpen} toast=${flash} />`}

      ${tab==='issue' && html`<${NewTransaction} mode="issuance"
        sites=${sites} employees=${employees} items=${items}
        defaultSite=${siteFilter} onSaved=${loadOpen} toast=${flash} />`}

      ${tab==='active' && html`<${ActiveBorrows} rows=${open} onReturn=${doReturn} />`}

      ${tab==='stock' && html`<div>
        <${SetStock} items=${items} sites=${sites} defaultSite=${siteFilter}
          onSaved=${loadStock} toast=${flash} />
        <${StockSummary} rows=${stockRows} outCounts=${outCounts} />
      </div>`}

      <p class="note">Tip: add real employees & items in Supabase (Table Editor) — they appear in the pickers automatically.</p>
    </div>

    ${toast && html`<div class=${'toast' + (toast.err?' err':'')}>${toast.msg}</div>`}
  `;
}

render(html`<${App} />`, document.getElementById('app'));
